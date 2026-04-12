import type { Express } from "express";
import { storage } from "../storage";
import { mcpClient, type MCPProvider } from "../mcp-client";
import { openaiService } from "../openai-service";
import { type GeneratedFile } from "@shared/schema";
import { validateTerraformRequest, formatValidationErrors } from "../terraform-validator";
import { optionalAuth, type AuthenticatedRequest } from "../middleware/auth";
import { validateRequest } from "../middleware/validate";
import { sessionIdParams } from "@shared/api-contracts/common";
import {
  generateTerraformBody,
  terraformCliRepairBody,
  terraformCicdRepairBody,
} from "@shared/api-contracts/terraform-generation";
import { ensureVariablesTfFromMainTf } from "../terraform-variable-sync";
import { validateStandaloneRootMainTf } from "../terraform-standalone-root-validation";
import { fileBasenameKey } from "../utils/generated-files-dedupe";
import { runTerraformWorkspaceValidation } from "../terraform-cli-validate";
import {
  repairSessionTerraformAfterCliFailure,
  repairSessionTerraformFromCiPlanLogs,
  shouldAttemptTerraformCliRepair,
} from "../terraform-module-cli-repair";
import {
  buildTerraformGeneratorMetadata,
  isTerraformGeneratorMetadataPath,
  shouldIncludeFileInStandaloneRepoFetch,
  TERRAFORM_GENERATOR_METADATA_FILENAME,
} from "../terraform-generator-metadata";

// Helper function to repair JSON (same as in openai-service.ts)
function repairJson(jsonText: string): string {
  let repaired = jsonText.trim();
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');
  repaired = repaired.replace(/,(\s*\n\s*[}\]])/g, '$1');
  repaired = repaired.replace(/\/\/.*$/gm, '');
  repaired = repaired.replace(/\/\*[\s\S]*?\*\//g, '');
  repaired = repaired.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, (match, prefix, key) => {
    if (!match.includes('"')) {
      return `${prefix}"${key}":`;
    }
    return match;
  });
  return repaired;
}

export function registerTerraformGenerationRoutes(app: Express): void {
  app.post("/api/sessions/:id/generate-terraform", optionalAuth, validateRequest({ params: sessionIdParams, body: generateTerraformBody }), async (req: AuthenticatedRequest, res) => {
    console.log('\n🚀 ========== GENERATE TERRAFORM ENDPOINT CALLED ==========');
    console.log(`   Timestamp: ${new Date().toISOString()}`);
    console.log(`   Session ID: ${req.params.id}`);
    console.log(`   Request body keys: ${Object.keys(req.body).join(', ')}`);

    try {
      const { description, childModuleResources, childModuleRepoName, childModuleProvider } = req.body;
      const sessionId = req.params.id;

      // CRITICAL: Validate description immediately
      if (!description || typeof description !== 'string' || description.trim().length === 0) {
        console.error('❌ CRITICAL ERROR: Description is missing or empty!');
        console.error(`   Description value: "${description}"`);
        console.error(`   Description type: ${typeof description}`);
        return res.status(400).json({
          error: 'Description is required',
          details: ['Please provide a description of the resources you want to create.']
        });
      }

      console.log(`\n📝 Description received: "${description.substring(0, 200)}${description.length > 200 ? '...' : ''}"`);
      console.log(`📝 Description length: ${description.length} characters`);

      // Get session to access cloudProvider and moduleApproach
      const session = await storage.getSession(sessionId);
      if (!session) {
        console.error(`❌ Session ${sessionId} not found!`);
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!session.userId || session.userId !== req.userId) {
        console.warn(`[SECURITY] Terraform generation session access denied: sessionId=${sessionId} sessionOwner=${session.userId} requesterId=${req.userId ?? 'anonymous'} ip=${req.ip}`);
        return res.status(403).json({ error: 'Access denied to this session' });
      }

      console.log(`✅ Session found: ${sessionId}`);
      console.log(`   Module approach: ${session.moduleApproach}`);
      console.log(`   Cloud provider: ${session.cloudProvider || session.detectedCloudProvider || 'None'}`);

      // Phase 1: Basic Rule-Based Validation
      console.log('\n🔍 ========== PHASE 1: VALIDATION ==========');
      console.log(`📝 Validating request: "${description.substring(0, 100)}${description.length > 100 ? '...' : ''}"`);
      console.log(`📝 Full description length: ${description.length} characters`);
      console.log(`📝 Module approach: ${session.moduleApproach}`);
      if (session.moduleApproach === 'aggregated-root') {
        console.log(`📝 Child module resources: ${childModuleResources?.length || 0} available`);
        if (childModuleResources && Array.isArray(childModuleResources) && childModuleResources.length > 0) {
          console.log(`📝 Available child module resources: ${childModuleResources.map((r: any) => typeof r === 'string' ? r : r.type).join(', ')}`);
        }
      }

      // Use session cloud provider if available (detected from repository scan)
      const sessionProvider = session.cloudProvider || session.detectedCloudProvider;
      console.log(`   Session Cloud Provider: ${sessionProvider || 'None'}`);

      const validationResult = validateTerraformRequest(description, {
        sessionProvider: sessionProvider as 'azure' | 'aws' | 'gcp' | null,
        minLength: 10,
        maxLength: 2000
      });

      console.log(`   Validation Result: ${validationResult.isValid ? '✅ VALID' : '❌ INVALID'}`);

      // For aggregated-root modules: Use AI to extract resources for better accuracy
      let requestedResources = validationResult.detectedResources;
      if (session.moduleApproach === 'aggregated-root') {
        console.log(`\n🤖 AI Extracting resources for aggregated-root validation...`);
        const aiExtracted = await openaiService.extractResourcesFromDescription(
          description,
          sessionProvider as 'azure' | 'aws' | 'gcp' | null
        );
        if (aiExtracted.length > 0) {
          requestedResources = aiExtracted;
          console.log(`   ✅ AI Identified ${requestedResources.length} resource(s): ${requestedResources.join(', ')}`);
        } else {
          console.log(`   ⚠️ AI failed to extract resources, falling back to regex detection`);
        }
      }

      if (validationResult.detectedProvider) {
        console.log(`   Detected Provider: ${validationResult.detectedProvider}`);
      }
      if (requestedResources.length > 0) {
        console.log(`   Target Resources: ${requestedResources.join(', ')}`);
      }
      if (validationResult.errors.length > 0) {
        console.log(`   Errors: ${validationResult.errors.join('; ')}`);
      }
      if (validationResult.warnings.length > 0) {
        console.log(`   Warnings: ${validationResult.warnings.join('; ')}`);
      }

      // For aggregated-root modules: Validate requested resources against child module
      if (session.moduleApproach === 'aggregated-root') {
        if (!childModuleResources || !Array.isArray(childModuleResources) || childModuleResources.length === 0) {
          return res.status(400).json({
            error: 'Child module not reviewed',
            details: ['Please review the child module repository first to identify available resources.']
          });
        }

        const availableResources = childModuleResources.map((r: any) => typeof r === 'string' ? r : r.type);

        // Check if any requested resources are not available in child module
        const unavailableResources = requestedResources.filter(req => {
          // Normalize resource names (e.g., "azurerm_storage_account" should match "azurerm_storage_account")
          return !availableResources.some(avail =>
            avail.toLowerCase() === req.toLowerCase() ||
            avail.toLowerCase().includes(req.toLowerCase()) ||
            req.toLowerCase().includes(avail.toLowerCase())
          );
        });

        if (unavailableResources.length > 0) {
          return res.status(400).json({
            error: 'Resources not available in child module',
            details: [
              `The following resources are not available in the child module: ${unavailableResources.join(', ')}`,
              `Available resources in child module: ${availableResources.length > 0 ? availableResources.join(', ') : 'None detected'}`,
              'Please use only resources that exist in the child module, or update the child module to include the required resources.'
            ],
            unavailableResources,
            availableResources,
            requestedResources
          });
        }

        console.log(`   ✅ All requested resources are available in child module`);
      }

      // If validation failed, return error immediately
      if (!validationResult.isValid) {
        const errorMessage = formatValidationErrors(validationResult);
        console.log('==========================================\n');
        return res.status(400).json({
          error: 'Validation failed',
          details: validationResult.errors,
          warnings: validationResult.warnings.length > 0 ? validationResult.warnings : undefined,
          validationResult: {
            detectedProvider: validationResult.detectedProvider,
            detectedResources: requestedResources
          }
        });
      }

      // If there are warnings, log them but continue
      if (validationResult.warnings.length > 0) {
        console.log(`   ⚠️  Proceeding with warnings: ${validationResult.warnings.join('; ')}`);
      }

      console.log('==========================================\n');

      // Workflow gating: ensure backend configuration step has been completed
      if (session.moduleApproach && session.moduleApproach !== 'child-module') {
        // Root modules must have backend configured (validated, created, or declined)
        const backendConfigured = session.backendValidated === 'true' ||     // Existing backend validated
                                  session.backendValidated === 'pending' ||  // New backend configured (to be created)
                                  session.backendValidated === 'skipped' ||  // User declined backend
                                  session.backendDeclined === 'true';        // Alternative decline tracking

        if (!backendConfigured) {
          return res.status(400).json({
            error: 'Backend configuration required before generating Terraform. Please configure or decline backend setup.',
            requiresBackendConfiguration: true
          });
        }
      }

      // Prepare backend configuration based on cloud provider
      const cloudProvider = session.cloudProvider || 'azure';
      const backendConfig = session.hasBackend === 'true' ? {
        hasBackend: true,
        backendType: session.backendType || (cloudProvider === 'aws' ? 's3' : 'azurerm'),
        // Azure backend fields
        storageAccount: session.backendStorageAccount || undefined,
        resourceGroup: session.backendResourceGroup || undefined,
        container: session.backendContainer || undefined,
        stateKey: session.backendStateKey || undefined,
        location: session.backendLocation || undefined,
        // AWS backend fields (reuse container for bucket, location for region)
        bucket: cloudProvider === 'aws' ? (session.backendContainer || undefined) : undefined,
        // Extract DynamoDB table from stateKey if stored in format "state-key|dynamodb-table"
        dynamodbTable: cloudProvider === 'aws' ? (session.backendStateKey?.includes('|') ? session.backendStateKey.split('|')[1] : 'terraform-state-lock') : undefined,
        region: cloudProvider === 'aws' ? (session.backendLocation || 'us-east-1') : undefined,
      } : { hasBackend: false };

      // Get existing files for standalone root modules (to append instead of replace)
      // IMPORTANT: Fetch from repository, not session storage, to get the latest code
      // CRITICAL: Also handle case where moduleApproach is null but files exist
      let existingFilesForAppend: Array<{ path: string; content: string }> | undefined = undefined;

      // CRITICAL: First, try to fetch files from repository if they exist
      // This ensures we have the latest code before checking if we should append
      let repoFilesForAppend: Array<{ path: string; content: string }> = [];
      if (session.provider && session.repositoryName) {
        try {
          const repoFiles = await mcpClient.scanRepositoryFiles(
            session.provider as MCPProvider,
            session.repositoryName,
            'main'
          );

          repoFilesForAppend = repoFiles.filter((file) => {
            const normalizedPath = file.path.replace(/^\/+|\/+$/g, "");
            const shouldInclude = shouldIncludeFileInStandaloneRepoFetch(normalizedPath);
            const fileName = (normalizedPath.split("/").pop() || normalizedPath).toLowerCase();
            if (fileName.includes("tfvars")) {
              console.log(
                `      🔍 Checking tfvars file: "${file.path}" → normalized: "${normalizedPath}" → shouldInclude: ${shouldInclude}`
              );
            }
            return shouldInclude;
          });

          if (repoFilesForAppend.length > 0) {
            console.log(`\n📋 Found ${repoFilesForAppend.length} file(s) in repository for appending`);
            repoFilesForAppend.forEach(file => {
              console.log(`   - ${file.path} (${file.content.length} chars)`);
            });

            // CRITICAL: Check if dev.terraform.tfvars was found
            const hasTfvars = repoFilesForAppend.some(f => {
              const normalizedPath = f.path.replace(/^\/+|\/+$/g, '').toLowerCase();
              const fileName = normalizedPath.split('/').pop() || normalizedPath;
              return fileName === 'dev.terraform.tfvars';
            });
            if (!hasTfvars) {
              console.error(`\n   ⚠️⚠️⚠️  WARNING: dev.terraform.tfvars NOT FOUND in repoFilesForAppend!`);
              // Check if it exists in raw repoFiles
              const rawTfvars = repoFiles.find(f => {
                const normalizedPath = f.path.replace(/^\/+|\/+$/g, '').toLowerCase();
                const fileName = normalizedPath.split('/').pop() || normalizedPath;
                return fileName === 'dev.terraform.tfvars';
              });
              if (rawTfvars) {
                console.error(`   ⚠️  File EXISTS in raw repoFiles but was FILTERED OUT!`);
                console.error(`   ⚠️  Raw file: "${rawTfvars.path}"`);
              }
            } else {
              console.log(`   ✅ dev.terraform.tfvars found in repoFilesForAppend`);
            }
          }
        } catch (error: any) {
          console.warn(`   ⚠️  Could not fetch from repository for appending: ${error.message}`);
        }
      }

      // Check if we should treat as standalone-root (explicit or inferred from files)
      // BUT: Skip for aggregated-root - it should always create fresh files
      const sessionFilesCheck = await storage.getFilesBySession(sessionId);
      const shouldAppend = (session.moduleApproach === 'standalone-root' ||
                          (session.moduleApproach === null && (sessionFilesCheck.length > 0 || repoFilesForAppend.length > 0))) &&
                          session.moduleApproach !== 'aggregated-root';

      if (shouldAppend) {
        // First check session storage (might have files from previous generation or scan)
        const sessionFiles = await storage.getFilesBySession(sessionId);
        console.log(`\n📋 Checking session storage: Found ${sessionFiles.length} total file(s)`);
        sessionFiles.forEach(f => {
          console.log(`   - ${f.fileName} (ID: ${f.id})`);
        });

        const sessionTerraformFiles = sessionFiles.filter((file) => {
          const normalized = file.fileName.replace(/^\/+|\/+$/g, "");
          return shouldIncludeFileInStandaloneRepoFetch(normalized);
        });
        console.log(`   📄 Terraform resource files in session: ${sessionTerraformFiles.length}`);

        // Use repository files if we already fetched them, otherwise fetch now
        if (repoFilesForAppend.length > 0) {
          // Use files we already fetched
          existingFilesForAppend = repoFilesForAppend;
          console.log(`   📋 Using repository files for appending (already fetched)`);

          // Update session storage with repository files (preserve IDs)
          console.log(`   💾 Updating ${repoFilesForAppend.length} file(s) in session storage with latest repository content...`);
          const sessionFilesMap = new Map<string, GeneratedFile>();
          sessionFiles.forEach(f => {
            sessionFilesMap.set(f.fileName.toLowerCase(), f);
          });

          for (const repoFile of repoFilesForAppend) {
            const fileName = repoFile.path.split('/').pop() || repoFile.path;
            const existingSessionFile = sessionFilesMap.get(fileName.toLowerCase());

            if (existingSessionFile) {
              console.log(`      ✅ Updating ${fileName} in session storage (ID: ${existingSessionFile.id}) - PRESERVING ID`);
              await storage.updateFile(existingSessionFile.id, repoFile.content);
            } else {
              console.error(`      ⚠️  File ${fileName} not found in session storage, creating as fallback`);
              await storage.createFile({
                sessionId,
                fileName: fileName,
                content: repoFile.content,
              });
            }
          }
          console.log(`   ✅ Files updated in session storage (IDs preserved for matching)`);
        } else {
          // Fetch from repository to get the latest code
          let repoFiles: Array<{ path: string; content: string }> = [];
          if (session.provider && session.repositoryName) {
            try {
              console.log(`\n📥 Fetching existing files from repository for appending...`);
              repoFiles = await mcpClient.scanRepositoryFiles(
              session.provider as MCPProvider,
              session.repositoryName,
              'main'
            );

            const repoTerraformFiles = repoFiles.filter((file) => {
              const normalizedPath = file.path.replace(/^\/+|\/+$/g, "");
              return shouldIncludeFileInStandaloneRepoFetch(normalizedPath);
            });

            console.log(`   ✅ Found ${repoTerraformFiles.length} file(s) in repository`);
            repoTerraformFiles.forEach(file => {
              console.log(`      - ${file.path} (${file.content.length} chars)`);
            });

            // CRITICAL: Check if dev.terraform.tfvars was found
            const hasTfvars = repoTerraformFiles.some(f => {
              const normalizedPath = f.path.replace(/^\/+|\/+$/g, '').toLowerCase();
              const fileName = normalizedPath.split('/').pop() || normalizedPath;
              return fileName === 'dev.terraform.tfvars';
            });
            if (!hasTfvars) {
              console.error(`\n   ⚠️⚠️⚠️  WARNING: dev.terraform.tfvars NOT FOUND in repository files!`);
              console.error(`   ⚠️  Check if file exists in repository or if filter is excluding it!`);
              // Check if it exists in raw repoFiles
              const rawTfvars = repoFiles.find(f => {
                const normalizedPath = f.path.replace(/^\/+|\/+$/g, '').toLowerCase();
                const fileName = normalizedPath.split('/').pop() || normalizedPath;
                return fileName === 'dev.terraform.tfvars';
              });
              if (rawTfvars) {
                console.error(`   ⚠️  File EXISTS in raw repoFiles but was FILTERED OUT!`);
                console.error(`   ⚠️  Raw file: "${rawTfvars.path}"`);
              } else {
                console.error(`   ⚠️  File does NOT exist in repository at all!`);
              }
            } else {
              console.log(`   ✅ dev.terraform.tfvars found in repository files`);
            }

            // Use repository files (latest code) if available, otherwise use session files
            if (repoTerraformFiles.length > 0) {
              existingFilesForAppend = repoTerraformFiles;
              console.log(`   📋 Using repository files for appending (latest code)`);

              // CRITICAL: Use ALL session files (not just filtered) to find existing files
              // This ensures we find files that were stored during scan
              console.log(`   💾 Updating ${repoTerraformFiles.length} file(s) in session storage with latest repository content...`);
              const sessionFilesMap = new Map<string, GeneratedFile>();
              // Use ALL session files, not just filtered ones
              sessionFiles.forEach(f => {
                sessionFilesMap.set(f.fileName.toLowerCase(), f);
              });
              console.log(`   📋 Session files map has ${sessionFilesMap.size} entries`);

              for (const repoFile of repoTerraformFiles) {
                const fileName = repoFile.path.split('/').pop() || repoFile.path;
                const existingSessionFile = sessionFilesMap.get(fileName.toLowerCase());

                if (existingSessionFile) {
                  // File exists - update it with latest repository content (PRESERVE ID!)
                  console.log(`      ✅ Updating ${fileName} in session storage (ID: ${existingSessionFile.id}) - PRESERVING ID`);
                  await storage.updateFile(existingSessionFile.id, repoFile.content);
                } else {
                  // File doesn't exist in session - this shouldn't happen if scan worked
                  // But create it anyway as fallback
                  console.error(`      ⚠️  File ${fileName} not found in session storage, creating as fallback`);
                  console.error(`      ⚠️  This might break matching - files should have been stored during scan!`);
                  console.error(`      ⚠️  Available session files: ${Array.from(sessionFilesMap.keys()).join(', ')}`);
                  await storage.createFile({
                    sessionId,
                    fileName: fileName,
                    content: repoFile.content,
                  });
                }
              }
              console.log(`   ✅ Files updated in session storage (IDs preserved for matching)`);
            } else if (sessionTerraformFiles.length > 0) {
              existingFilesForAppend = sessionTerraformFiles.map(file => ({
                path: file.fileName,
                content: file.content
              }));
              console.log(`   📋 Using session files for appending (no repository files found)`);
            }
          } catch (repoError: any) {
            console.warn(`   ⚠️  Could not fetch from repository: ${repoError.message}`);
            console.warn(`   Falling back to session storage files`);

            // Fallback to session files if repository fetch fails
            if (sessionTerraformFiles.length > 0) {
              existingFilesForAppend = sessionTerraformFiles.map(file => ({
                path: file.fileName,
                content: file.content
              }));
            }
          }
          }
        }

        // If we still don't have files for appending, use session files
        // BUT: Skip for aggregated-root - it should always create fresh files
        if (!existingFilesForAppend && sessionTerraformFiles.length > 0 && session.moduleApproach !== 'aggregated-root') {
          // No repository info, use session files
          existingFilesForAppend = sessionTerraformFiles.map(file => ({
            path: file.fileName,
            content: file.content
          }));
          console.log(`   📋 Using session files for appending (no repository access)`);
        }

        if (existingFilesForAppend && existingFilesForAppend.length > 0 && session.moduleApproach !== 'aggregated-root') {
          console.log(`\n📋 Will append new resources to ${existingFilesForAppend.length} existing file(s):`);
          existingFilesForAppend.forEach(file => {
            console.log(`   - ${file.path} (${file.content.length} chars)`);
          });

          // CRITICAL: Check if dev.terraform.tfvars is included
          const hasTfvars = existingFilesForAppend.some(f => {
            const normalizedPath = f.path.replace(/^\/+|\/+$/g, '').toLowerCase();
            const fileName = normalizedPath.split('/').pop() || normalizedPath;
            return fileName === 'dev.terraform.tfvars';
          });
          if (!hasTfvars) {
            console.error(`\n   ⚠️⚠️⚠️  WARNING: dev.terraform.tfvars NOT FOUND in existing files!`);
            console.error(`   ⚠️  This means AI won't know about existing tfvars and might replace it!`);
            console.error(`   ⚠️  Files included: ${existingFilesForAppend.map(f => f.path).join(', ')}`);
          } else {
            console.log(`   ✅ dev.terraform.tfvars is included in existing files`);
          }

          console.log(`   AI will preserve ALL existing content and add new resources.\n`);
        } else {
          if (session.moduleApproach === 'aggregated-root') {
            console.log(`\n📦 AGGREGATED-ROOT: Creating fresh files (no existing files to append)`);
          } else {
            console.error(`\n   ⚠️⚠️⚠️  WARNING: No existing files found for appending!`);
            console.error(`   ⚠️  This means AI will create all files as new (including dev.terraform.tfvars)!`);
          }
        }
      }

      // Generate Terraform files with context
      // For aggregated-root: Don't pass existing files - create fresh
      const filesForGeneration = (session.moduleApproach === 'aggregated-root')
        ? undefined
        : existingFilesForAppend;

      if (session.moduleApproach === 'aggregated-root') {
        console.log(`\n📦 AGGREGATED-ROOT: Creating fresh files (not appending to existing)`);
        console.log(`   Description: "${description.substring(0, 200)}${description.length > 200 ? '...' : ''}"`);
      }

      const result = await openaiService.generateTerraform(
        description,
        session.cloudProvider,
        session.moduleApproach,
        backendConfig,
        filesForGeneration
      );

      if (session.moduleApproach === "standalone-root") {
        const mainTfFile = result.files.find((f) => {
          const base = f.path.split("/").pop() || f.path;
          return base === "main.tf";
        });
        if (mainTfFile) {
          const violation = validateStandaloneRootMainTf(mainTfFile.content);
          if (violation) {
            console.error(`❌ Standalone root validation failed: ${violation}`);
            return res.status(400).json({
              error: "Invalid standalone root module",
              details: [violation],
            });
          }
        }
      }

      // CRITICAL: Log what AI actually generated
      console.log(`\n📥 [AI RESPONSE] AI generated ${result.files.length} file(s):`);
      result.files.forEach((file, idx) => {
        console.log(`   ${idx + 1}. ${file.path} (${file.content.length} chars)`);

        // For aggregated-root: Check for module blocks in main.tf
        if (file.path === 'main.tf' && session.moduleApproach === 'aggregated-root') {
          const modulePattern = /module\s+"([^"]+)"/g;
          const modules: string[] = [];
          let match;
          while ((match = modulePattern.exec(file.content)) !== null) {
            modules.push(match[1]);
          }
          console.log(`      📦 Module blocks in AI response: ${modules.length}`);
          modules.forEach((mod, i) => {
            console.log(`         ${i + 1}. module "${mod}"`);
          });
          if (modules.length === 0) {
            console.error(`      ❌ WARNING: No module blocks found in main.tf for aggregated-root!`);
          }
        }

        // For main.tf, check what resources were generated (for non-aggregated-root)
        if (file.path === 'main.tf' && session.moduleApproach !== 'aggregated-root') {
          const resourcePattern = /resource\s+"([^"]+)"\s+"([^"]+)"/g;
          const resources: string[] = [];
          let match;
          while ((match = resourcePattern.exec(file.content)) !== null) {
            resources.push(`${match[1]}.${match[2]}`);
          }
          console.log(`      📦 Resources in AI response: ${resources.length}`);
          resources.forEach((res, i) => {
            console.log(`         ${i + 1}. ${res}`);
          });

          // Check specifically for container resources
          const hasContainerEnv = file.content.includes('azurerm_container_app_environment');
          const hasContainerRegistry = file.content.includes('azurerm_container_registry');
          console.log(`      🔍 Container resources check:`);
          console.log(`         - Container App Environment: ${hasContainerEnv ? '✅ FOUND' : '❌ NOT FOUND'}`);
          console.log(`         - Container Registry: ${hasContainerRegistry ? '✅ FOUND' : '❌ NOT FOUND'}`);
        }
      });

      // Check if required files are present for aggregated-root
      if (session.moduleApproach === 'aggregated-root') {
        const requiredFiles = ['main.tf', 'variables.tf', 'dev.terraform.tfvars', 'outputs.tf'];
        const generatedFileNames = result.files.map(f => f.path.split('/').pop() || f.path);
        const missingFiles = requiredFiles.filter(req => !generatedFileNames.includes(req));
        if (missingFiles.length > 0) {
          console.error(`\n❌ WARNING: Missing required files for aggregated-root: ${missingFiles.join(', ')}`);
          console.error(`   Generated files: ${generatedFileNames.join(', ')}`);
        } else {
          console.log(`\n✅ All required files present for aggregated-root: ${requiredFiles.join(', ')}`);
        }
      }

      // Validate child module structure
      if (session.moduleApproach === 'child-module') {
        // Check for forbidden blocks in child modules
        for (const file of result.files) {
          const content = file.content.toLowerCase();

          // Check for module blocks (forbidden in child modules)
          if (content.includes('module "') || content.includes("module '")) {
            throw new Error(`Child module validation failed: File "${file.path}" contains a "module" block. Child modules must use "resource" blocks only. Module blocks are only allowed in aggregated root modules.`);
          }

          // Check for provider blocks (forbidden in child modules)
          if (content.includes('provider "') || content.includes("provider '")) {
            throw new Error(`Child module validation failed: File "${file.path}" contains a "provider" block. Child modules should not include provider configuration.`);
          }

          // Check for terraform blocks (typically not in child modules)
          if (content.includes('terraform {')) {
            throw new Error(`Child module validation failed: File "${file.path}" contains a "terraform" block. Child modules should not include terraform configuration blocks.`);
          }
        }

        // Ensure we have actual files generated
        if (result.files.length === 0) {
          throw new Error('Child module validation failed: No files were generated. Expected resource-type folders with main.tf, variables.tf, and outputs.tf files.');
        }

        // Group files by folder and validate structure
        const folderMap = new Map<string, Set<string>>();
        for (const file of result.files) {
          const parts = file.path.split('/');
          if (parts.length < 2) {
            throw new Error(`Child module validation failed: File "${file.path}" is not in a folder. Child modules must be organized in folders by resource type (e.g., ResourceGroup/main.tf).`);
          }

          const folder = parts[0];
          const fileName = parts[parts.length - 1];

          if (!folderMap.has(folder)) {
            folderMap.set(folder, new Set());
          }
          folderMap.get(folder)!.add(fileName);
        }

        // Validate each folder has required files
        const requiredFiles = ['main.tf', 'variables.tf', 'outputs.tf'];
        for (const [folder, files] of Array.from(folderMap.entries())) {
          for (const required of requiredFiles) {
            if (!files.has(required)) {
              throw new Error(`Child module validation failed: Folder "${folder}" is missing required file "${required}". Each child module folder must contain: main.tf, variables.tf, and outputs.tf.`);
            }
          }
        }

        console.log(`✓ Child module validation passed: ${folderMap.size} module(s) with ${result.files.length} files generated`);
      }

      // For standalone root modules: Use the same files that were passed to AI for matching
      // This ensures consistency - we match against the exact files the AI saw
      let existingFilesBeforeProcessing: GeneratedFile[] = [];
      const preservedFiles: GeneratedFile[] = [];

      console.log(`\n🔍 Module approach: ${session.moduleApproach}`);
      console.log(`   Session ID: ${sessionId}`);

      // CRITICAL: Check if files exist in session - if they do, treat as standalone-root
      // This handles the case where moduleApproach is null but files exist (from scan)
      const sessionFilesCheckForDelete = await storage.getFilesBySession(sessionId);
      const hasExistingFiles = sessionFilesCheckForDelete.length > 0;

      if (session.moduleApproach === 'standalone-root' ||
          (session.moduleApproach === null && hasExistingFiles)) {
        // NOTE: We don't need existingFilesBeforeProcessing anymore
        // We'll get files directly from session storage when matching
        console.log(`\n📝 Standalone root module: Will match against session storage files directly`);
        if (session.moduleApproach === null && hasExistingFiles) {
          console.log(`   ⚠️  moduleApproach is null but ${hasExistingFiles} file(s) exist - treating as standalone-root`);
        }
        existingFilesBeforeProcessing = []; // Not used anymore, but keep for compatibility
      } else {
        // For child modules: Delete all session files and recreate
        // For aggregated-root: Preserve backend files, only delete resource files
        if (session.moduleApproach === 'child-module') {
          console.log(`\n🗑️  Deleting existing session files for ${session.moduleApproach}...`);
          await storage.deleteFilesBySession(sessionId);
        } else if (session.moduleApproach === 'aggregated-root') {
          // For aggregated-root: Preserve backend files, only delete resource files if they exist
          console.log(`\n🔍 Checking files for aggregated-root...`);
          const allSessionFiles = await storage.getFilesBySession(sessionId);
          const backendFiles = ['backend.tf', 'provider.tf', 'terraform.tf'];
          const resourceFilesToDelete = allSessionFiles.filter(f => !backendFiles.includes(f.fileName));

          console.log(`   Total files in session: ${allSessionFiles.length}`);
          console.log(`   Backend files: ${allSessionFiles.filter(f => backendFiles.includes(f.fileName)).map(f => f.fileName).join(', ') || 'none'}`);
          console.log(`   Resource files: ${resourceFilesToDelete.map(f => f.fileName).join(', ') || 'none'}`);

          if (resourceFilesToDelete.length > 0) {
            console.log(`   🗑️  Deleting ${resourceFilesToDelete.length} existing resource file(s) (preserving backend files):`);
            resourceFilesToDelete.forEach(f => console.log(`      - ${f.fileName}`));
            for (const file of resourceFilesToDelete) {
              await storage.deleteFile(file.id);
            }
            console.log(`   ✅ Deleted existing resource files, backend files preserved`);
          } else {
            console.log(`   ✅ No resource files to delete - will create new resource files (backend files preserved)`);
          }
        } else {
          console.log(`\n⚠️  moduleApproach is null and no files exist - will create new files`);
        }
      }

      // Generate README content
      const moduleApproachText = session.moduleApproach === 'child-module'
        ? 'Child Module (reusable component)'
        : session.moduleApproach === 'standalone-root'
        ? 'Standalone Root Module (complete infrastructure)'
        : session.moduleApproach === 'aggregated-root'
        ? 'Aggregated Root Module (composed from child modules)'
        : 'Not specified';

      const isChildModule = session.moduleApproach === 'child-module';

      const readmeContent = isChildModule
        ? `# Terraform Child Modules

This repository contains reusable Terraform child modules for managing cloud infrastructure.

## Structure

Each folder represents a separate child module for a specific resource type:

${result.files.map(f => `- \`${f.path}\``).join('\n')}

## Configuration

- **Cloud Provider**: ${session.cloudProvider ? session.cloudProvider.toUpperCase() : 'Not specified'}
- **Module Approach**: ${moduleApproachText}

## Usage

These child modules can be called from a parent/root module:

\`\`\`hcl
module "example" {
  source = "./ModuleName"

  # Pass required variables
  name     = "example"
  location = "eastus"
}
\`\`\`

## Generated by AI-Driven DevOps Platform

These modules were generated using natural language descriptions and AI assistance.
`
        : `# Terraform Infrastructure

This repository contains Terraform configuration files for managing cloud infrastructure.

## Files

${result.files.map(f => `- \`${f.path}\``).join('\n')}

## Configuration

- **Cloud Provider**: ${session.cloudProvider ? session.cloudProvider.toUpperCase() : 'Not specified'}
- **Module Approach**: ${moduleApproachText}
${session.hasBackend === 'true' ? `- **Backend**: Configured for remote state management using ${session.backendType}` : '- **Backend**: Local state management'}

## File Structure

${session.hasBackend === 'true' ? '- **backend.tf**: Backend configuration for state storage' : ''}
${result.files.some(f => f.path === 'provider.tf') ? '- **provider.tf**: Provider configuration and version requirements' : ''}
- **main.tf**: Resource definitions
- **variables.tf**: Input variable declarations
- **dev.terraform.tfvars**: Environment-specific variable values
- **outputs.tf**: Output values

## Usage

\`\`\`bash
# Initialize Terraform
terraform init

# Preview changes
terraform plan

# Apply configuration
terraform apply
\`\`\`

## Generated by AI-Driven DevOps Platform

This infrastructure was generated using natural language descriptions and AI assistance.
`;

      // Save generated files including README
      // Filter out backend.tf, provider.tf, and terraform.tf to prevent duplication
      // These files are created during backend configuration and should not be overwritten
      const protectedFiles = ['backend.tf', 'provider.tf', 'terraform.tf'];
      const filteredFiles = result.files.filter((file: any) => {
        const fileName = file.path.split('/').pop();
        return !protectedFiles.includes(fileName);
      });

      console.log(`\n📋 File filtering:`);
      console.log(`   AI generated: ${result.files.length} file(s)`);
      console.log(`   After filtering protected files: ${filteredFiles.length} file(s)`);
      filteredFiles.forEach(f => {
        console.log(`      - ${f.path}`);
      });

      const allFiles = [
        ...filteredFiles,
        { path: 'README.md', content: readmeContent },
        {
          path: TERRAFORM_GENERATOR_METADATA_FILENAME,
          content: buildTerraformGeneratorMetadata(session),
        },
      ];

      console.log(`   Total files to save (including README): ${allFiles.length}`);

      // For aggregated-root: Validate that required files are present
      if (session.moduleApproach === 'aggregated-root') {
        const requiredFiles = ['main.tf', 'variables.tf', 'dev.terraform.tfvars', 'outputs.tf'];
        const fileNames = allFiles.map(f => f.path.split('/').pop() || f.path);
        const missingFiles = requiredFiles.filter(req => !fileNames.includes(req));
        if (missingFiles.length > 0) {
          console.error(`\n❌ CRITICAL: Missing required files for aggregated-root: ${missingFiles.join(', ')}`);
          console.error(`   Files to save: ${fileNames.join(', ')}`);
          console.error(`   This means the AI did not generate all required files!`);
        }
      }

      // CRITICAL: Get ALL session files FIRST to check if we should treat as standalone-root
      // This must happen BEFORE we check moduleApproach
      let allSessionFilesNow = await storage.getFilesBySession(sessionId);
      console.log(`\n🔍 Checking for standalone-root behavior...`);
      console.log(`   moduleApproach: ${session.moduleApproach}`);
      console.log(`   Files in session: ${allSessionFilesNow.length}`);
      allSessionFilesNow.forEach(f => {
        console.log(`      - ${f.fileName} (ID: ${f.id}, ${f.content.length} chars)`);
      });

      // CRITICAL: If no files in session but repository exists, fetch from repository NOW
      // This handles the case where scan-repository wasn't called or files were cleared
      if (allSessionFilesNow.length === 0 && session.provider && session.repositoryName) {
        console.log(`\n   ⚠️  No files in session storage, but repository exists.`);
        console.log(`   🔄 Fetching files from repository and storing in session...`);
        try {
          const repoFiles = await mcpClient.scanRepositoryFiles(
            session.provider as MCPProvider,
            session.repositoryName,
            'main'
          );

          const terraformResourceFiles = repoFiles.filter((file) => {
            const normalizedPath = file.path.replace(/^\/+|\/+$/g, "");
            return shouldIncludeFileInStandaloneRepoFetch(normalizedPath);
          });

          console.log(`   💾 Storing ${terraformResourceFiles.length} file(s) in session storage...`);
          for (const repoFile of terraformResourceFiles) {
            // Normalize path: remove leading/trailing slashes
            const normalizedPath = repoFile.path.replace(/^\/+|\/+$/g, '');
            const fileName = normalizedPath.split('/').pop() || normalizedPath;
            console.log(`      📄 Processing file from repo: "${repoFile.path}" → normalized: "${normalizedPath}" → fileName: "${fileName}"`);
            const created = await storage.createFile({
              sessionId,
              fileName: fileName,
              content: repoFile.content,
            });
            console.log(`      ✅ Stored ${fileName} (ID: ${created.id})`);
          }

          // Re-fetch after storing
          allSessionFilesNow = await storage.getFilesBySession(sessionId);
          console.log(`   ✅ Now have ${allSessionFilesNow.length} file(s) in session storage`);
        } catch (error: any) {
          console.error(`   ❌ Failed to fetch from repository: ${error.message}`);
        }
      }

      // For standalone root modules: Update existing files instead of creating new ones
      // CRITICAL: Check moduleApproach OR if files exist in session (standalone-root behavior)
      // BUT: For aggregated-root, always create new files (don't treat as standalone-root)
      const isStandaloneRoot = (session.moduleApproach === 'standalone-root' ||
                                (session.moduleApproach === null && allSessionFilesNow.length > 0)) &&
                               session.moduleApproach !== 'aggregated-root';

      console.log(`   moduleApproach: ${session.moduleApproach}`);
      console.log(`   Files in session: ${allSessionFilesNow.length}`);
      console.log(`   isStandaloneRoot: ${isStandaloneRoot}`);

      // For aggregated-root: Log what files will be created
      if (session.moduleApproach === 'aggregated-root') {
        console.log(`\n📦 AGGREGATED-ROOT MODULE: Will create new files`);
        console.log(`   Files to create: ${allFiles.length}`);
        allFiles.forEach(f => {
          console.log(`      - ${f.path} (${f.content.length} chars)`);
        });
      }

      let savedFiles;
      if (isStandaloneRoot) {
        // Log why we're treating this as standalone-root
        if (session.moduleApproach === null) {
          console.log(`\n⚠️  WARNING: moduleApproach is null, but ${allSessionFilesNow.length} file(s) exist in session.`);
          console.log(`   Treating as standalone-root based on existing files.`);
        }
        savedFiles = [];

        // CRITICAL: Get ALL session files RIGHT NOW for matching
        // This is the SINGLE SOURCE OF TRUTH for existing files
        console.log(`\n${'='.repeat(80)}`);
        console.log(`🔍 STANDALONE ROOT: Starting file matching...`);
        console.log(`${'='.repeat(80)}`);
        console.log(`   Session ID: ${sessionId}`);
        console.log(`   Module approach: ${session.moduleApproach || 'null (inferred from existing files)'}`);
        console.log(`   Provider: ${session.provider}`);
        console.log(`   Repository: ${session.repositoryName}`);

        // Verify session exists
        const sessionCheck = await storage.getSession(sessionId);
        if (!sessionCheck) {
          console.error(`   ❌❌❌ CRITICAL: Session ${sessionId} does not exist!`);
          throw new Error(`Session ${sessionId} not found`);
        }
        console.log(`   ✅ Session verified: ${sessionCheck.id}`);

        // Get ALL files for this session (refresh to ensure we have latest)
        allSessionFilesNow = await storage.getFilesBySession(sessionId);
        console.log(`\n   📋 Fetched ${allSessionFilesNow.length} file(s) from session storage`);

        if (allSessionFilesNow.length > 0) {
          console.log(`   ✅ Files found in session storage:`);
          allSessionFilesNow.forEach(f => {
            console.log(`      - ${f.fileName} (ID: ${f.id}, ${f.content.length} chars, sessionId: ${f.sessionId})`);
          });
        } else {
          console.error(`   ❌ NO FILES FOUND in session storage!`);
          console.error(`   This means files were NOT stored during scan, or were cleared.`);
          console.error(`   Check scan logs above to see if files were stored.`);
        }

        // CRITICAL: If no files in session storage, fetch from repository IMMEDIATELY
        // This should NOT happen if scan worked, but we need this as safety net
        if (allSessionFilesNow.length === 0 && session.provider && session.repositoryName) {
          console.error(`\n   ❌ CRITICAL: No files in session storage! Fetching from repository NOW...`);
          try {
            const repoFiles = await mcpClient.scanRepositoryFiles(
              session.provider as MCPProvider,
              session.repositoryName,
              'main'
            );

            const terraformResourceFiles = repoFiles.filter((file) => {
              const normalizedPath = file.path.replace(/^\/+|\/+$/g, "");
              return shouldIncludeFileInStandaloneRepoFetch(normalizedPath);
            });

            console.error(`   💾 Storing ${terraformResourceFiles.length} file(s) in session storage...`);
            for (const repoFile of terraformResourceFiles) {
              // Normalize path: remove leading/trailing slashes
              const normalizedPath = repoFile.path.replace(/^\/+|\/+$/g, '');
              const fileName = normalizedPath.split('/').pop() || normalizedPath;
              console.error(`      📄 Processing file from repo: "${repoFile.path}" → normalized: "${normalizedPath}" → fileName: "${fileName}"`);
              const created = await storage.createFile({
                sessionId,
                fileName: fileName,
                content: repoFile.content,
              });
              console.error(`      ✅ Stored ${fileName} (ID: ${created.id})`);
            }

            // Re-fetch
            allSessionFilesNow = await storage.getFilesBySession(sessionId);
            console.error(`   ✅ Now have ${allSessionFilesNow.length} file(s) in session storage`);
          } catch (error: any) {
            console.error(`   ❌ Failed to fetch from repository: ${error.message}`);
          }
        }

        // FINAL CHECK: If still no files, this is a critical error
        if (allSessionFilesNow.length === 0) {
          console.error(`\n   ❌❌❌ CRITICAL ERROR: Still no files in session storage after all attempts!`);
          console.error(`   Session ID: ${sessionId}`);
          console.error(`   Provider: ${session.provider}`);
          console.error(`   Repository: ${session.repositoryName}`);
          console.error(`   This means files were NEVER stored, or session storage is broken.`);
          console.error(`   Files will be created as new (this is a BUG).`);
        }

        // Create a SIMPLE map: filename (lowercase) -> file
        // This is the ONLY map we need - simple and bulletproof
        const sessionFilesMap = new Map<string, GeneratedFile>();
        allSessionFilesNow.forEach(f => {
          const key = f.fileName.toLowerCase();
          sessionFilesMap.set(key, f);
          // Also add just the filename (without path) as key
          const fileNameOnly = f.fileName.split('/').pop() || f.fileName;
          const fileNameOnlyLower = fileNameOnly.toLowerCase();
          sessionFilesMap.set(fileNameOnlyLower, f);
          // Also add with path variations
          if (f.fileName !== fileNameOnly) {
            sessionFilesMap.set(f.fileName, f);
          }
        });

        console.log(`\n   📋 Session files map created with ${sessionFilesMap.size} entries`);
        console.log(`   Map keys: ${Array.from(sessionFilesMap.keys()).join(', ')}`);
        console.log(`   Original file names in session:`);
        allSessionFilesNow.forEach(f => {
          console.log(`      - "${f.fileName}" (ID: ${f.id})`);
        });

        console.log(`\n📝 Processing ${allFiles.length} generated file(s):`);

        for (const file of allFiles) {
          // README: upsert like other files so repeat runs do not duplicate rows
          if (file.path.toLowerCase() === "readme.md") {
            const existingReadme = allSessionFilesNow.find(
              (f) => fileBasenameKey(f.fileName) === "readme.md"
            );
            if (existingReadme) {
              console.log(`\n   📄 ${file.path} - Updating existing README (ID: ${existingReadme.id})`);
              const updated = await storage.updateFile(existingReadme.id, file.content);
              savedFiles.push(updated);
            } else {
              console.log(`\n   📄 ${file.path} - Creating README`);
              const created = await storage.createFile({
                sessionId,
                fileName: file.path,
                content: file.content,
              });
              savedFiles.push(created);
            }
            continue;
          }

          // Generator metadata: always replace whole file (no Terraform merge)
          if (isTerraformGeneratorMetadataPath(file.path)) {
            const metaKey = fileBasenameKey(TERRAFORM_GENERATOR_METADATA_FILENAME);
            const existingMeta = allSessionFilesNow.find(
              (f) => fileBasenameKey(f.fileName) === metaKey
            );
            if (existingMeta) {
              console.log(`\n   📄 ${file.path} - Updating ${TERRAFORM_GENERATOR_METADATA_FILENAME} (ID: ${existingMeta.id})`);
              const updated = await storage.updateFile(existingMeta.id, file.content);
              savedFiles.push(updated);
            } else {
              console.log(`\n   📄 ${file.path} - Creating ${TERRAFORM_GENERATOR_METADATA_FILENAME}`);
              const created = await storage.createFile({
                sessionId,
                fileName: TERRAFORM_GENERATOR_METADATA_FILENAME,
                content: file.content,
              });
              savedFiles.push(created);
            }
            continue;
          }

          // Extract filename (handle paths like "./main.tf" or "main.tf")
          let fileNameOnly = file.path.split('/').pop() || file.path;
          const fileNameOnlyLower = fileNameOnly.toLowerCase();
          const filePathLower = file.path.toLowerCase();

          console.log(`\n   🔍 Processing: "${file.path}"`);
          console.log(`      Filename only: "${fileNameOnly}"`);
          console.log(`      Filename (lowercase): "${fileNameOnlyLower}"`);
          console.log(`      Path (lowercase): "${filePathLower}"`);

          // SIMPLE MATCHING: Try multiple lookup strategies
          let existingFile = sessionFilesMap.get(fileNameOnlyLower);

          if (!existingFile) {
            existingFile = sessionFilesMap.get(filePathLower);
          }

          if (!existingFile) {
            existingFile = sessionFilesMap.get(file.path);
          }

          // If still not found, try direct search (case-insensitive) - same as main.tf, variables.tf
          if (!existingFile) {
            existingFile = allSessionFilesNow.find(sf => {
              const sfName = sf.fileName.toLowerCase();
              const sfNameOnly = (sf.fileName.split('/').pop() || sf.fileName).toLowerCase();
              return sfName === fileNameOnlyLower ||
                     sfNameOnly === fileNameOnlyLower ||
                     sfName === filePathLower ||
                     sf.fileName === file.path ||
                     sf.fileName === fileNameOnly;
            });
            if (existingFile) {
              console.log(`      🔄 Found via direct search: "${existingFile.fileName}" (ID: ${existingFile.id})`);
            }
          }

          if (existingFile) {
            // FILE EXISTS - UPDATE IT (PRESERVE ID!)
            console.log(`      ✅ FOUND existing file: "${existingFile.fileName}" (ID: ${existingFile.id})`);
            console.log(`      📝 UPDATING (preserving ID: ${existingFile.id})`);
            console.log(`         Old size: ${existingFile.content.length} chars`);
            console.log(`         New size: ${file.content.length} chars`);
            console.log(`         Session ID: ${existingFile.sessionId} (should match: ${sessionId})`);

            // CRITICAL: Verify session ID matches
            if (existingFile.sessionId !== sessionId) {
              console.error(`         ❌❌❌ CRITICAL: Session ID mismatch!`);
              console.error(`         File sessionId: ${existingFile.sessionId}`);
              console.error(`         Current sessionId: ${sessionId}`);
              console.error(`         This file belongs to a different session!`);
            }

            // CRITICAL: ALWAYS merge for ALL files (regardless of size)
            // Size comparison is unreliable - AI might replace content even if file is larger
            // We always extract new content and append it to existing to ensure no data loss
            const isTfvarsFile = fileNameOnlyLower === 'terraform.tfvars' || fileNameOnlyLower === 'dev.terraform.tfvars';

            // Always merge - don't rely on size comparison
            console.log(`\n         🔧 ALWAYS MERGING (ensuring existing content is preserved + new content added)...`);
            if (file.content.length < existingFile.content.length) {
              console.warn(`         ⚠️  Generated file is ${existingFile.content.length - file.content.length} chars SMALLER - likely replaced content`);
            } else if (file.content.length > existingFile.content.length) {
              console.warn(`         ⚠️  Generated file is ${file.content.length - existingFile.content.length} chars LARGER - might have replaced or appended`);
            } else {
              console.warn(`         ⚠️  Generated file is same size - likely replaced content`);
            }
            console.log(`         📋 Merging ensures: existing content preserved + only NEW content added`);

            let finalContent = file.content;
            // Always merge - extract new content and append to existing
            // Merge logic: Append new resources to existing content
            const existingContent = existingFile.content;
            const newContent = file.content;

              // Helper functions for merging (defined outside block to avoid strict mode issues)
              const calculateSimilarity = (str1: string, str2: string): number => {
                const longer = str1.length > str2.length ? str1 : str2;
                const shorter = str1.length > str2.length ? str2 : str1;
                if (longer.length === 0) return 1.0;
                const distance = levenshteinDistance(longer, shorter);
                return (longer.length - distance) / longer.length;
              };

              const levenshteinDistance = (str1: string, str2: string): number => {
                const matrix: number[][] = [];
                for (let i = 0; i <= str2.length; i++) {
                  matrix[i] = [i];
                }
                for (let j = 0; j <= str1.length; j++) {
                  matrix[0][j] = j;
                }
                for (let i = 1; i <= str2.length; i++) {
                  for (let j = 1; j <= str1.length; j++) {
                    if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                      matrix[i][j] = matrix[i - 1][j - 1];
                    } else {
                      matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                      );
                    }
                  }
                }
                return matrix[str2.length][str1.length];
              };

              // Helper function to extract Terraform blocks (handles nested braces)
              const extractTerraformBlocks = (content: string, blockType: 'resource' | 'variable' | 'output'): string[] => {
                const blocks: string[] = [];
                const pattern = new RegExp(`${blockType}\\s+"([^"]+)"(?:\\s+"([^"]+)")?\\s*\\{`, 'g');
                let match;

                while ((match = pattern.exec(content)) !== null) {
                  const startPos = match.index;
                  let braceCount = 0;
                  let inBlock = false;
                  let blockEnd = startPos;

                  // Find the matching closing brace
                  for (let i = startPos; i < content.length; i++) {
                    if (content[i] === '{') {
                      braceCount++;
                      inBlock = true;
                    } else if (content[i] === '}') {
                      braceCount--;
                      if (inBlock && braceCount === 0) {
                        blockEnd = i + 1;
                        break;
                      }
                    }
                  }

                  if (blockEnd > startPos) {
                    blocks.push(content.substring(startPos, blockEnd));
                  }
                }

                return blocks;
              };

              // For main.tf: Smart merge - trust AI if it includes all existing content, otherwise extract and append
              if (fileNameOnlyLower === 'main.tf') {
                // First, verify if AI response includes all existing resources
                const existingResources = extractTerraformBlocks(existingContent, 'resource');
                const aiResources = extractTerraformBlocks(newContent, 'resource');

                console.error(`         🔍 [MERGE] Analysis:`);
                console.error(`            Existing resources: ${existingResources.length}`);
                console.error(`            AI response resources: ${aiResources.length}`);

                // Check if AI response includes all existing resources
                let allExistingFound = true;
                const missingResources: string[] = [];

                for (const existingRes of existingResources) {
                  const existingResMatch = existingRes.match(/resource\s+"([^"]+)"\s+"([^"]+)"/);
                  if (existingResMatch) {
                    const resType = existingResMatch[1];
                    const resName = existingResMatch[2];
                    const pattern = new RegExp(`resource\\s+"${resType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s+"${resName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);

                    if (!pattern.test(newContent)) {
                      allExistingFound = false;
                      missingResources.push(`${resType}.${resName}`);
                    }
                  }
                }

                if (allExistingFound && aiResources.length >= existingResources.length) {
                  // AI response includes all existing resources - trust it (it's complete)
                  console.error(`         ✅ [MERGE] AI response includes all existing resources - using AI response as-is`);
                  console.error(`         ✅ [MERGE] AI added ${aiResources.length - existingResources.length} new resource(s)`);
                  finalContent = newContent; // Use AI response directly
                } else {
                  // AI response is missing existing resources - extract new ones and append
                  console.error(`         ⚠️  [MERGE] AI response missing ${missingResources.length} existing resource(s): ${missingResources.join(', ')}`);
                  console.error(`         🔧 [MERGE] Extracting new resources and appending to existing...`);

                  // Extract resource blocks from new content
                  const newResources = extractTerraformBlocks(newContent, 'resource');

                  console.error(`         📊 [MERGE] Found ${newResources.length} resource(s) in AI response`);

                  // Check if new resources already exist in old content
                  // Use more lenient matching - check for exact resource type + name combination
                  const resourcesToAdd = newResources.filter(newRes => {
                    const newResName = newRes.match(/resource\s+"([^"]+)"\s+"([^"]+)"/);
                    if (!newResName) {
                      // If we can't parse the resource, include it anyway (better safe than sorry)
                      console.error(`         ⚠️  [MERGE] Could not parse resource block, including it anyway`);
                      return true;
                    }
                    const resType = newResName[1];
                    const resName = newResName[2];

                    // Check if this exact resource (type + name) exists in existing content
                    // Use word boundaries to avoid partial matches
                    const exactPattern = new RegExp(`resource\\s+"${resType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s+"${resName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*\\{`);
                    const exists = exactPattern.test(existingContent);

                    if (exists) {
                      console.error(`         ⚠️  [MERGE] Resource "${resType}.${resName}" appears to exist, but will check content similarity...`);
                      // Even if name matches, check if content is significantly different
                      // If content is different, it might be an update - include it
                      const existingResMatch = existingContent.match(new RegExp(`resource\\s+"${resType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s+"${resName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*\\{[\\s\\S]*?\\}`));
                      if (existingResMatch) {
                        const existingResContent = existingResMatch[0];
                        // If new resource is significantly different (more than 20% different), include it
                        // This handles cases where AI might be updating a resource
                        const similarity = calculateSimilarity(existingResContent, newRes);
                        if (similarity < 0.8) {
                          console.error(`         ✅ [MERGE] Resource "${resType}.${resName}" exists but content is different (similarity: ${(similarity * 100).toFixed(1)}%) - including as update`);
                          return true;
                        }
                      }
                      return false; // Exact duplicate, skip
                    }
                    return true; // New resource, include it
                  });

                  console.error(`         📊 [MERGE] Summary: ${newResources.length} total in AI, ${resourcesToAdd.length} new, ${newResources.length - resourcesToAdd.length} potential duplicates`);

                  // CRITICAL: Always add new resources, even if duplicate detection thinks they exist
                  // Better to have potential duplicates than missing resources
                  if (resourcesToAdd.length > 0) {
                    finalContent = existingContent.trim() + '\n\n' + resourcesToAdd.join('\n\n');
                    console.error(`         ✅ Merged: Added ${resourcesToAdd.length} new resource(s) to existing content`);
                    resourcesToAdd.forEach((res) => {
                      const resMatch = res.match(/resource\s+"([^"]+)"\s+"([^"]+)"/);
                      if (resMatch) {
                        console.error(`            ✅ Added: resource "${resMatch[1]}" "${resMatch[2]}"`);
                      } else {
                        console.error(`            ✅ Added: resource (unparseable, but included)`);
                      }
                    });
                  } else if (newResources.length > 0) {
                    // Do not re-inject all resources — that duplicates blocks and breaks plans.
                    console.error(`         ⚠️  [MERGE] Duplicate filter removed every resource from AI output — keeping existing file unchanged`);
                    finalContent = existingContent;
                  } else {
                    // No resources found in AI response at all
                    finalContent = existingContent;
                    console.error(`         ⚠️⚠️⚠️  [MERGE] CRITICAL: No resources found in AI response!`);
                    console.error(`         ⚠️  Keeping existing content unchanged`);
                  }
                }
              }
              // For variables.tf: Extract new variables and append
              else if (fileNameOnlyLower === 'variables.tf') {
                const newVariables = extractTerraformBlocks(newContent, 'variable');

                // Check if new variables already exist
                const variablesToAdd = newVariables.filter(newVar => {
                  const varNameMatch = newVar.match(/variable\s+"([^"]+)"/);
                  if (!varNameMatch) return false;
                  const varName = varNameMatch[1];
                  return !existingContent.includes(`variable "${varName}"`);
                });

                if (variablesToAdd.length > 0) {
                  finalContent = existingContent.trim() + '\n\n' + variablesToAdd.join('\n\n');
                  console.error(`         ✅ Merged: Added ${variablesToAdd.length} new variable(s) to existing content`);
                } else {
                  finalContent = existingContent;
                  console.error(`         ⚠️  No new variables found, keeping existing content`);
                }
              }
              // For outputs.tf: Extract new outputs and append
              else if (fileNameOnlyLower === 'outputs.tf') {
                const newOutputs = extractTerraformBlocks(newContent, 'output');

                // Check if new outputs already exist
                const outputsToAdd = newOutputs.filter(newOut => {
                  const outNameMatch = newOut.match(/output\s+"([^"]+)"/);
                  if (!outNameMatch) return false;
                  const outName = outNameMatch[1];
                  return !existingContent.includes(`output "${outName}"`);
                });

                if (outputsToAdd.length > 0) {
                  finalContent = existingContent.trim() + '\n\n' + outputsToAdd.join('\n\n');
                  console.error(`         ✅ Merged: Added ${outputsToAdd.length} new output(s) to existing content`);
                } else {
                  finalContent = existingContent;
                  console.error(`         ⚠️  No new outputs found, keeping existing content`);
                }
              }
              // For terraform.tfvars or dev.terraform.tfvars: Append like other files (main.tf, variables.tf, outputs.tf)
              // AI generates complete content, we append it to existing (same logic as other files)
              else if (fileNameOnlyLower === 'terraform.tfvars' || fileNameOnlyLower === 'dev.terraform.tfvars') {
                // Extract all key-value pairs from new content
                const newLines = newContent.split('\n');
                const newKeyValuePairs: string[] = [];

                newLines.forEach(line => {
                  const trimmed = line.trim();
                  if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                    // Extract key-value pairs from new content
                    newKeyValuePairs.push(trimmed);
                  }
                });

                // Check which keys already exist in existing content
                const existingKeys = new Set<string>();
                const existingAllLines = existingContent.split('\n');
                existingAllLines.forEach(line => {
                  const trimmed = line.trim();
                  if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                    const match = trimmed.match(/^([^=]+?)\s*=\s*(.+)$/);
                    if (match) {
                      existingKeys.add(match[1].trim());
                    }
                  }
                });

                // Filter out key-value pairs that already exist (avoid duplicates)
                const newPairsToAdd = newKeyValuePairs.filter(pair => {
                  const match = pair.match(/^([^=]+?)\s*=\s*(.+)$/);
                  if (match) {
                    const key = match[1].trim();
                    return !existingKeys.has(key);
                  }
                  return false;
                });

                if (newPairsToAdd.length > 0) {
                  // Append new key-value pairs to existing content (like main.tf, variables.tf, outputs.tf)
                  finalContent = existingContent.trim() + '\n\n' + newPairsToAdd.join('\n');
                  console.error(`         ✅ Merged: Added ${newPairsToAdd.length} new variable assignment(s) to existing content (appended like main.tf/variables.tf/outputs.tf)`);
                } else {
                  // No new pairs, keep existing content
                  finalContent = existingContent;
                  console.error(`         ⚠️  No new variable assignments found, keeping existing content`);
                }
              }
              // For other files: Keep existing content (don't risk data loss)
              else {
                finalContent = existingContent;
                console.error(`         ⚠️  Unknown file type, keeping existing content to prevent data loss`);
              }

            console.error(`         📊 Final merged size: ${finalContent.length} chars (original: ${existingFile.content.length}, AI: ${file.content.length})`);

            try {
              const updated = await storage.updateFile(existingFile.id, finalContent);
              savedFiles.push(updated);
              console.log(`         ✅ UPDATED successfully (ID preserved: ${updated.id})`);
              console.log(`         Verified: Updated file ID matches original: ${updated.id === existingFile.id}`);
            } catch (updateError: any) {
              console.error(`         ❌ Update failed: ${updateError.message}`);
              console.error(`         Error details:`, updateError);
              throw updateError;
            }
          } else {
            // FILE NOT FOUND - Log why
            console.error(`\n${'='.repeat(80)}`);
            console.error(`      ❌❌❌ FILE NOT FOUND in session storage!`);
            console.error(`${'='.repeat(80)}`);
            console.error(`         Looking for: "${file.path}"`);
            console.error(`         Filename: "${fileNameOnly}"`);
            console.error(`         Filename (lowercase): "${fileNameOnlyLower}"`);
            console.error(`         Path (lowercase): "${filePathLower}"`);
            console.error(`\n         Available map keys (${sessionFilesMap.size}):`);
            Array.from(sessionFilesMap.keys()).forEach(key => {
              console.error(`            - "${key}"`);
            });
            console.error(`\n         Available files in session (${allSessionFilesNow.length}):`);
            allSessionFilesNow.forEach(sf => {
              console.error(`            - "${sf.fileName}" (ID: ${sf.id}, sessionId: ${sf.sessionId})`);
            });
            console.error(`${'='.repeat(80)}\n`);

            // FILE DOES NOT EXIST - Check if it's a Terraform file that should exist
            const isTerraformFile = fileNameOnlyLower.endsWith('.tf') || fileNameOnlyLower.endsWith('.tfvars');
            const isBackendConfig = ['backend.tf', 'provider.tf', 'terraform.tf'].includes(fileNameOnlyLower);

            if (isTerraformFile && !isBackendConfig) {
              // This is a Terraform resource file that should have existed
              // This means files weren't stored during scan - CRITICAL ERROR
              console.error(`\n      ❌❌❌ CRITICAL: Terraform file "${fileNameOnly}" not found in session storage!`);
              console.error(`      This file should have been stored during repository scan.`);
              console.error(`      Creating as new file (this is a bug - file should exist).`);
            }

            // Create new file (for new files like dev.terraform.tfvars, or if scan failed)
            console.log(`      ➕ Creating new file: "${file.path}"`);
            const created = await storage.createFile({
              sessionId,
              fileName: file.path,
              content: file.content,
            });
            savedFiles.push(created);
            console.log(`         ✅ Created with ID: ${created.id}`);
          }
        }

        // Log summary of what was updated vs created
        // Compare against the session files we fetched BEFORE processing
        const filesBeforeMatching = allSessionFilesNow.map(f => f.id);
        console.log(`\n📊 SUMMARY OF FILE OPERATIONS:`);
        console.log(`   Total files processed: ${allFiles.length}`);
        console.log(`   Files in savedFiles: ${savedFiles.length}`);
        console.log(`   Files in session before matching: ${filesBeforeMatching.length}`);
        console.log(`   File IDs before matching: ${filesBeforeMatching.join(', ')}`);

        const updatedFiles = savedFiles.filter(f => {
          // Check if this file was updated (same ID existed before matching)
          return filesBeforeMatching.includes(f.id);
        });

        const createdFiles = savedFiles.filter(f => {
          // Check if this file was created (ID didn't exist before matching)
          return !filesBeforeMatching.includes(f.id);
        });

        console.log(`   ✅ Updated files: ${updatedFiles.length}`);
        updatedFiles.forEach(f => {
          console.log(`      - ${f.fileName} (ID: ${f.id}) - ID PRESERVED ✅`);
        });

        console.log(`   ➕ Created files: ${createdFiles.length}`);
        createdFiles.forEach(f => {
          console.log(`      - ${f.fileName} (ID: ${f.id}) - NEW FILE ⚠️`);
        });

        const updatedCount = updatedFiles.length;
        const createdCount = createdFiles.length;
        console.log(`\n✅ File processing complete:`);
        console.log(`   📝 Updated: ${updatedCount} file(s) (IDs preserved)`);
        console.log(`   ➕ Created: ${createdCount} file(s) (new IDs)`);
        console.log(`   📋 Total: ${savedFiles.length} file(s)`);

        if (updatedCount === 0 && filesBeforeMatching.length > 0) {
          console.error(`\n   ❌ CRITICAL: No files were updated despite ${filesBeforeMatching.length} files existing!`);
          console.error(`   This means the matching logic failed completely.`);
        }
      } else {
        // For child modules and aggregated root: Create all files fresh
        console.log(`\n📦 ========== CREATING NEW FILES ==========`);
        console.log(`   Module approach: ${session.moduleApproach || 'child/aggregated'}`);
        console.log(`   Total files to create: ${allFiles.length}`);
        allFiles.forEach((file, idx) => {
          console.log(`   ${idx + 1}. ${file.path} (${file.content.length} chars)`);
        });

        if (allFiles.length === 0) {
          console.error(`\n❌ CRITICAL ERROR: No files to create!`);
          console.error(`   This means either:`);
          console.error(`   1. AI did not generate any files`);
          console.error(`   2. All files were filtered out`);
          return res.status(500).json({
            error: 'No files to create',
            details: ['AI did not generate any files or all files were filtered out. Please check server logs.']
          });
        }

        // For aggregated-root: Check if backend files already exist and preserve them
        const backendFiles = ['backend.tf', 'provider.tf', 'terraform.tf'];
        const existingFiles = await storage.getFilesBySession(sessionId);
        const existingBackendFiles = existingFiles.filter(f => backendFiles.includes(f.fileName));

        savedFiles = [];

        const existingByPath = new Map(
          existingFiles.map((f) => [f.fileName.toLowerCase(), f] as const),
        );

        // For aggregated-root: Preserve existing backend files
        if (session.moduleApproach === 'aggregated-root' && existingBackendFiles.length > 0) {
          console.log(`\n   🔒 Preserving ${existingBackendFiles.length} existing backend file(s):`);
          existingBackendFiles.forEach(f => {
            console.log(`      - ${f.fileName} (ID: ${f.id})`);
            savedFiles.push(f); // Add existing backend files to savedFiles
          });
        }

        for (const file of allFiles) {
          // Skip backend files if they already exist (for aggregated-root)
          if (session.moduleApproach === 'aggregated-root' && backendFiles.includes(file.path)) {
            const existingBackendFile = existingBackendFiles.find(f => f.fileName === file.path);
            if (existingBackendFile) {
              console.log(`   ⏭️  Skipping ${file.path} (already exists, preserved)`);
              continue;
            }
          }

          const pathKey = file.path.toLowerCase();
          const existingSameName = existingByPath.get(pathKey);

          try {
            if (existingSameName) {
              console.log(`\n   💾 Updating existing file: ${file.path} (ID: ${existingSameName.id})...`);
              const updated = await storage.updateFile(existingSameName.id, file.content);
              savedFiles.push(updated);
              console.log(`   ✅ Updated: ${file.path} (${updated.content.length} chars)`);
              continue;
            }

            console.log(`\n   💾 Creating file: ${file.path}...`);
            const created = await storage.createFile({
              sessionId,
              fileName: file.path,
              content: file.content,
            });
            existingByPath.set(pathKey, created);
            console.log(`   ✅ Successfully created: ${file.path} (ID: ${created.id}, ${created.content.length} chars, sessionId: ${created.sessionId})`);

            // Verify the file was saved correctly by fetching it back
            const verifyFiles = await storage.getFilesBySession(sessionId);
            const savedFile = verifyFiles.find(f => f.id === created.id);
            if (!savedFile) {
              console.error(`   ❌ CRITICAL: File ${file.path} was created but not found in session storage!`);
            } else if (savedFile.content.length !== file.content.length) {
              console.error(`   ❌ CRITICAL: File ${file.path} content length mismatch! Expected: ${file.content.length}, Got: ${savedFile.content.length}`);
            } else if (savedFile.content.trim().length === 0) {
              console.error(`   ❌ CRITICAL: File ${file.path} is EMPTY after saving!`);
            } else {
              console.log(`   ✅ Verified: File ${file.path} saved correctly (${savedFile.content.length} chars, not empty)`);
            }

            savedFiles.push(created);
          } catch (error: any) {
            console.error(`   ❌ FAILED to create ${file.path}: ${error.message}`);
            console.error(`   Error stack: ${error.stack}`);
            return res.status(500).json({
              error: `Failed to create file ${file.path}`,
              details: [error.message]
            });
          }
        }

        console.log(`\n✅ ========== FILE CREATION COMPLETE ==========`);
        console.log(`   Successfully created/preserved ${savedFiles.length} file(s) for ${session.moduleApproach || 'child/aggregated'} module`);
        savedFiles.forEach(f => {
          console.log(`      - ${f.fileName} (ID: ${f.id})`);
        });
      }

      // For aggregated-root: Store child module main.tf files for Checkov security scanning.
      // We only store files for modules actually referenced by source = "./XYZ" in the root main.tf,
      // and only the main.tf from each module dir (not variables/outputs) to keep check count minimal.
      if (session.moduleApproach === 'aggregated-root' && childModuleRepoName && childModuleProvider) {
        try {
          // Parse root main.tf to discover which module source directories are referenced
          const rootMainTf = allFiles.find(f => f.path === 'main.tf' || f.path.endsWith('/main.tf'));
          const referencedDirs = new Set<string>();
          if (rootMainTf) {
            const sourceRe = /source\s*=\s*["']\.\/([^"'/\\]+)/g;
            let m: RegExpExecArray | null;
            while ((m = sourceRe.exec(rootMainTf.content)) !== null) {
              referencedDirs.add(m[1].toLowerCase()); // e.g. "appservice", "appserviceplan"
            }
            console.log(`\n📦 Root main.tf references ${referencedDirs.size} module dir(s): ${[...referencedDirs].join(', ')}`);
          }

          console.log(`   Fetching child module files from "${childModuleRepoName}"...`);
          const childFiles = await mcpClient.scanRepositoryFiles(
            childModuleProvider as MCPProvider,
            childModuleRepoName,
            'main'
          );

          // Normalise a dir name for loose matching (strip separators, lowercase)
          const normDir = (s: string) => s.toLowerCase().replace(/[_\-\s]/g, '');
          const normRefs = new Set([...referencedDirs].map(normDir));

          // Only keep main.tf from referenced module directories (minimises Checkov check count)
          const childTfFiles = childFiles.filter(f => {
            if (!f.content || f.content.trim().length === 0) return false;
            const parts = f.path.replace(/\\/g, '/').split('/');
            if (parts.length < 2) return false; // skip top-level files
            const dirName = parts[0];
            const fileName = parts[parts.length - 1].toLowerCase();
            // Accept only main.tf from directories referenced in root main.tf
            // If no sources were detected, fall back to all main.tf files (safety)
            const dirMatches = normRefs.size === 0 || normRefs.has(normDir(dirName));
            return fileName === 'main.tf' && dirMatches;
          });

          console.log(`   Storing ${childTfFiles.length} child module file(s)`);
          for (const file of childTfFiles) {
            const created = await storage.createFile({
              sessionId,
              fileName: file.path,  // e.g. "AppService/main.tf" — preserves directory structure
              content: file.content,
            });
            console.log(`   ✅ Stored: ${file.path} (${file.content.length} bytes, ID: ${created.id})`);
          }
        } catch (childErr: any) {
          // Non-fatal: child module files are best-effort for scanning
          console.warn(`   ⚠️  Could not fetch child module files (scan will use root module only): ${childErr.message}`);
        }
      }

      // For aggregated-root: Ensure backend files are included in savedFiles response
      // Backend files are already preserved in savedFiles, so we don't need to recreate them
      if (session.moduleApproach === 'aggregated-root') {
        // Get all files (backend + resource) to return in response
        const allFinalFiles = await storage.getFilesBySession(sessionId);
        console.log(`\n📋 Final files in session (backend + resource): ${allFinalFiles.length}`);
        allFinalFiles.forEach(f => {
          console.log(`      - ${f.fileName} (ID: ${f.id})`);
        });

        // Update savedFiles to include all files for the response
        savedFiles = allFinalFiles;
        console.log(`\n✅ Response will include ${savedFiles.length} file(s) (backend + resource files)`);
      }

      // Restore preserved backend configuration files (backend.tf, provider.tf, terraform.tf)
      // Only for non-aggregated-root modules (aggregated-root already has them preserved)
      if (preservedFiles.length > 0 && session.moduleApproach !== 'aggregated-root') {
        await Promise.all(
          preservedFiles.map(file =>
            storage.createFile({
              sessionId,
              fileName: file.fileName,
              content: file.content,
            })
          )
        );
        console.log(`Preserved ${preservedFiles.length} backend configuration file(s): ${preservedFiles.map(f => f.fileName).join(', ')}`);
      }

      await ensureVariablesTfFromMainTf(sessionId, description);

      // For aggregated-root: Get all files (backend + resource) to return in response
      if (session.moduleApproach === 'aggregated-root') {
        const allFinalFiles = await storage.getFilesBySession(sessionId);
        console.log(`\n📋 Final response: Including ${allFinalFiles.length} file(s) (backend + resource):`);
        allFinalFiles.forEach(f => {
          console.log(`      - ${f.fileName} (ID: ${f.id}, ${f.content.length} chars, sessionId: ${f.sessionId})`);
          if (f.content.length === 0) {
            console.error(`         ⚠️  WARNING: File ${f.fileName} is EMPTY!`);
          }
        });

        // Verify all files have content
        const emptyFiles = allFinalFiles.filter(f => f.content.trim().length === 0);
        if (emptyFiles.length > 0) {
          console.error(`\n❌ CRITICAL: ${emptyFiles.length} file(s) are EMPTY:`);
          emptyFiles.forEach(f => {
            console.error(`   - ${f.fileName} (ID: ${f.id})`);
          });
        }

        savedFiles = allFinalFiles;
      }

      // Update session to Build Workspace step based on module approach
      // - standalone-root / child: Step 8 (Build Workspace, step 7 removed)
      // - aggregated-root: Step 9 (Build Workspace for aggregated-root)
      const reviewStep = session.moduleApproach === 'aggregated-root' ? '9' : '8';
      await storage.updateSession(sessionId, {
        currentStep: reviewStep,
        workflowStep: 'terraform_generation'
      });
      console.log(`\n📝 Updated session to step ${reviewStep} (moduleApproach: ${session.moduleApproach})`);

      const filesForCliCheck = await storage.getFilesBySession(sessionId);
      let terraformCliCheck = await runTerraformWorkspaceValidation(
        filesForCliCheck.map((f) => ({ fileName: f.fileName, content: f.content })),
      );
      if (terraformCliCheck.ran) {
        console.log(
          `\n🔧 Terraform CLI: init=${terraformCliCheck.initOk} validate=${terraformCliCheck.validateOk} diagnostics=${terraformCliCheck.diagnostics.length}`,
        );
      } else if (terraformCliCheck.skippedReason) {
        console.log(`\n🔧 Terraform CLI check skipped: ${terraformCliCheck.skippedReason}`);
      }

      let terraformCliRepair: { attempted: boolean; succeeded?: boolean } = { attempted: false };
      if (shouldAttemptTerraformCliRepair(terraformCliCheck)) {
        terraformCliRepair.attempted = true;
        try {
          const { check, succeeded } = await repairSessionTerraformAfterCliFailure(
            sessionId,
            description,
            session,
            terraformCliCheck,
          );
          terraformCliCheck = check;
          terraformCliRepair.succeeded = succeeded;
          if (succeeded) {
            console.log("\n✅ Terraform CLI AI repair: validate passed after fix");
            savedFiles = await storage.getFilesBySession(sessionId);
          } else {
            console.warn("\n⚠️ Terraform CLI AI repair: validate still failing — review diagnostics or Fix/Scan");
            savedFiles = await storage.getFilesBySession(sessionId);
          }
        } catch (repairErr: unknown) {
          console.error("Terraform CLI AI repair failed:", repairErr);
          terraformCliRepair.succeeded = false;
        }
      }

      console.log(`\n✅ Sending response with ${savedFiles.length} file(s)`);
      res.json({ files: savedFiles, terraformCliCheck, terraformCliRepair });
    } catch (error: any) {
      const sessionIdForError = req.params.id || 'unknown';
      console.error('\n❌ ========== GENERATE TERRAFORM ERROR ==========');
      console.error(`   Timestamp: ${new Date().toISOString()}`);
      console.error('   Session ID:', sessionIdForError);
      console.error('   Error type:', error?.constructor?.name);
      console.error('   Error message:', error?.message);
      console.error('   Error stack:', error?.stack);
      console.error('   Error details:', {
        message: error?.message,
        stack: error?.stack,
        name: error?.name,
        sessionId: sessionIdForError
      });

      // Return more specific error messages
      let errorMessage = 'Failed to generate Terraform files';
      let statusCode = 500;

      if (error?.message) {
        errorMessage = error.message;

        // Handle validation errors (400)
        if (error.message.includes('validation failed') ||
            error.message.includes('Child module validation')) {
          statusCode = 400;
        }

        // Handle backend configuration errors (400)
        if (error.message.includes('Backend configuration required')) {
          statusCode = 400;
        }
      }

      res.status(statusCode).json({
        error: errorMessage,
        details: process.env.NODE_ENV === 'development' ? error?.stack : undefined
      });
    }
  });

  /** AI repair after failed terraform validate (same engine as post-generate repair; for manual retry before commit). */
  app.post(
    "/api/sessions/:id/terraform-cli-repair",
    optionalAuth,
    validateRequest({ params: sessionIdParams, body: terraformCliRepairBody }),
    async (req: AuthenticatedRequest, res) => {
      try {
        const sessionId = req.params.id;
        const session = await storage.getSession(sessionId);
        if (!session) {
          return res.status(404).json({ error: "Session not found" });
        }
        if (!session.userId || session.userId !== req.userId) {
          return res.status(403).json({ error: "Access denied to this session" });
        }

        const description =
          typeof req.body?.description === "string" ? req.body.description : "";

        const sessionFiles = await storage.getFilesBySession(sessionId);
        let terraformCliCheck = await runTerraformWorkspaceValidation(
          sessionFiles.map((f) => ({ fileName: f.fileName, content: f.content })),
        );

        if (terraformCliCheck.validateOk) {
          return res.json({
            success: true,
            message: "Terraform validate already passed; nothing to repair.",
            terraformCliCheck,
            terraformCliRepair: { attempted: false, succeeded: true },
            files: sessionFiles,
          });
        }

        if (!shouldAttemptTerraformCliRepair(terraformCliCheck)) {
          return res.status(400).json({
            error: "Cannot repair",
            details: terraformCliCheck.skippedReason || "CLI check did not run or repair is disabled",
            terraformCliCheck,
          });
        }

        const { check, succeeded } = await repairSessionTerraformAfterCliFailure(
          sessionId,
          description,
          session,
          terraformCliCheck,
        );
        const files = await storage.getFilesBySession(sessionId);

        return res.json({
          success: succeeded,
          message: succeeded
            ? "Terraform files updated; validate passed after AI repair."
            : "Terraform files were updated but validate may still report issues.",
          terraformCliCheck: check,
          terraformCliRepair: { attempted: true, succeeded },
          files,
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("terraform-cli-repair:", error);
        return res.status(500).json({ error: msg || "CLI repair failed" });
      }
    },
  );

  /** AI repair from GitHub Actions terraform plan/validate logs (CI/CD card “Review and Fix”). */
  app.post(
    "/api/sessions/:id/terraform-cicd-repair",
    optionalAuth,
    validateRequest({ params: sessionIdParams, body: terraformCicdRepairBody }),
    async (req: AuthenticatedRequest, res) => {
      try {
        const sessionId = req.params.id;
        const session = await storage.getSession(sessionId);
        if (!session) {
          return res.status(404).json({ error: "Session not found" });
        }
        if (!session.userId || session.userId !== req.userId) {
          return res.status(403).json({ error: "Access denied to this session" });
        }

        const planLogs = String(req.body?.planLogs || "").trim();
        if (!planLogs) {
          return res.status(400).json({ error: "planLogs is required" });
        }
        const description =
          typeof req.body?.description === "string" ? req.body.description : "";

        await repairSessionTerraformFromCiPlanLogs(sessionId, description, session, planLogs);

        return res.json({
          success: true,
          message: "Terraform updated from CI logs. Commit again to re-run validation.",
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("terraform-cicd-repair:", error);
        return res.status(500).json({ error: msg || "CI repair failed" });
      }
    },
  );
}
