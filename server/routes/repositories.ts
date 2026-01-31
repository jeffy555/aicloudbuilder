import type { Express } from "express";
import { storage } from "../storage";
import { mcpClient, type MCPProvider, type MCPServerType, type RepositoryCredentials } from "../mcp-client";
import { bitwardenService, isBitwardenConfigured } from "../services/bitwarden-service";
import { optionalAuth, type AuthenticatedRequest } from "../middleware/auth";
import { type Repository } from "@shared/schema";
import { analyzeTerraformFiles } from "../terraform-parser";
import { validateTerraformRequest } from "../terraform-validator";
import { openaiService } from "../openai-service";
import { type InsertSession } from "@shared/schema";
import { type GeneratedFile } from "@shared/schema";

async function resolveRepositoryCredentials(
  provider: MCPProvider,
  userId?: string
): Promise<RepositoryCredentials> {
  if (!userId) return {};

  if (!isBitwardenConfigured()) {
    return {};
  }

  try {
    if (provider === "github") {
      const secret = await bitwardenService.getUserSecret(userId, "github");
      if (secret?.token) {
        return {
          github: {
            token: secret.token,
            owner: secret.owner,
          },
        };
      }
    } else if (provider === "azure") {
      const secret = await bitwardenService.getUserSecret(userId, "azure-devops");
      if (secret?.org && secret?.pat && secret?.project) {
        return {
          azure: {
            org: secret.org,
            pat: secret.pat,
            project: secret.project,
          },
        };
      }
    }
  } catch (error: any) {
    console.warn(`⚠️  Unable to load ${provider} secrets for user ${userId}:`, error?.message || error);
  }

  return {};
}

/**
 * Repository operations routes
 */
export function registerRepositoryRoutes(app: Express): void {
  // Pre-warm MCP connection for a provider (optional, called when provider is selected)
  app.post("/api/repositories/:provider/prewarm", async (req, res) => {
    try {
      const provider = req.params.provider as MCPProvider;
      const serverType = (req.query.serverType as MCPServerType) || 'devops';
      console.log(`🔥 [API] Pre-warming connection for ${provider}-${serverType}...`);
      
      // Pre-warm in background (don't wait)
      mcpClient.prewarmConnection(provider, serverType).catch((error) => {
        console.warn(`⚠️  [API] Pre-warm failed for ${provider}-${serverType}:`, error.message);
      });
      
      res.json({ status: 'pre-warming', provider, serverType });
    } catch (error) {
      console.error('Error pre-warming connection:', error);
      res.status(500).json({ error: 'Failed to pre-warm connection' });
    }
  });

  // List repositories
  app.get("/api/repositories/:provider", optionalAuth, async (req: AuthenticatedRequest, res) => {
    const requestStart = Date.now();
    try {
      const provider = req.params.provider as MCPProvider;
      const credentials = await resolveRepositoryCredentials(provider, req.userId);
      
      const githubToken = credentials.github?.token || process.env.GITHUB_TOKEN;
      const githubOwner = credentials.github?.owner || process.env.GITHUB_OWNER;
      const azureOrg = credentials.azure?.org || process.env.AZURE_DEVOPS_ORG;
      const azurePat = credentials.azure?.pat || process.env.AZURE_DEVOPS_PAT;
      const azureProject = credentials.azure?.project || process.env.AZURE_DEVOPS_PROJECT;

      if (provider === 'azure' && (!azureOrg || !azurePat || !azureProject)) {
        return res.status(400).json({
          error: 'Azure DevOps credentials not configured. Please add them in Settings or set AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT, and AZURE_DEVOPS_PROJECT environment variables.'
        });
      }
      if (provider === 'github' && (!githubToken || !githubOwner)) {
        return res.status(400).json({
          error: 'GitHub credentials not configured. Please add them in Settings or set GITHUB_TOKEN and GITHUB_OWNER environment variables.'
        });
      }
      
      console.log(`📡 [API] Listing repositories for ${provider}...`);
      const repos = await mcpClient.listRepositories(provider, credentials);
      const totalTime = Date.now() - requestStart;
      console.log(`⏱️  [API] Repository list completed in ${totalTime}ms`);
      console.log(`📊 [API] Received ${repos.length} repository/repositories from MCP client`);
      
      if (repos.length === 0) {
        console.warn(`⚠️  [API] No repositories returned! This might indicate:`);
        console.warn(`   1. MCP server returned empty result`);
        console.warn(`   2. REST API fallback also returned empty`);
        console.warn(`   3. Credentials might be incorrect`);
        console.warn(`   4. Project might not have any repositories`);
      } else {
        console.log(`📋 [API] Sample repository structure:`, JSON.stringify(repos[0], null, 2));
      }
      
      // Transform to common format
      const formatted: Repository[] = repos.map((repo: any, index: number) => {
        const formattedRepo = {
          id: repo.id || String(repo.repositoryId || index),
          name: repo.name || repo.Name || repo.repositoryName || 'Unknown',
          fullName:
            repo.full_name ||
            (repo.owner?.login && repo.name ? `${repo.owner.login}/${repo.name}` : undefined),
          lastUpdated: repo.updated_at || repo.lastUpdateTime || repo.updatedDate || repo.lastUpdated || '',
          branch: repo.default_branch || repo.defaultBranch || repo.branch || 'main'
        };
        console.log(`   📦 Formatted repo ${index + 1}: ${formattedRepo.name} (ID: ${formattedRepo.id})`);
        return formattedRepo;
      });

      console.log(`✅ [API] Returning ${formatted.length} formatted repository/repositories`);
      res.json(formatted);
    } catch (error: any) {
      console.error('Error listing repositories:', error);

      if (error?.status === 401) {
        return res.status(401).json({
          error:
            (req.params.provider as MCPProvider) === "github"
              ? "GitHub credentials are invalid or expired. Update them in Settings."
              : "Azure DevOps credentials are invalid or missing."
        });
      }

      if (error?.status === 403) {
        return res.status(403).json({
          error: "You do not have permission to list repositories for the selected provider."
        });
      }

      res.status(500).json({ error: 'Failed to list repositories' });
    }
  });

  // List branches for the currently selected session repository
  app.get("/api/sessions/:id/branches", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (!session.provider || !session.repositoryName) {
        return res.status(400).json({
          error: 'Repository not configured',
          details: 'Select a repository before choosing a branch'
        });
      }

      const branches = await mcpClient.listRepositoryBranches(
        session.provider as MCPProvider,
        session.repositoryName
      );

      const defaultBranch = session.repositoryBranch || branches[0] || 'main';

      res.json({
        branches,
        defaultBranch
      });
    } catch (error: any) {
      console.error('Error listing branches:', error);
      res.status(500).json({
        error: 'Failed to load branches',
        details: error.message || 'Unknown error'
      });
    }
  });

  // Create repository
  app.post("/api/repositories/:provider", async (req, res) => {
    const provider = req.params.provider as MCPProvider;
    const { name, description } = req.body;
    
    try {
      // Validate provider credentials
      if (provider === 'azure' && (!process.env.AZURE_DEVOPS_ORG || !process.env.AZURE_DEVOPS_PAT || !process.env.AZURE_DEVOPS_PROJECT)) {
        return res.status(400).json({ error: 'Azure DevOps credentials not configured. Please set AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT, and AZURE_DEVOPS_PROJECT environment variables.' });
      }
      if (provider === 'github' && (!process.env.GITHUB_TOKEN || !process.env.GITHUB_OWNER)) {
        return res.status(400).json({ error: 'GitHub credentials not configured. Please set GITHUB_TOKEN and GITHUB_OWNER environment variables.' });
      }

      const repo = await mcpClient.createRepository(provider, name, description);
      res.json(repo);
    } catch (error: any) {
      console.error('Error creating repository:', error);
      
      // Check if repository already exists
      if (error.message && error.message.includes('already exists')) {
        return res.status(409).json({ 
          error: `A repository named "${name}" already exists. Please choose a different name or select the existing repository.` 
        });
      }
      
      res.status(500).json({ 
        error: 'Failed to create repository',
        details: error.message || 'Unknown error occurred'
      });
    }
  });

  // Validate requested resources against child module resources (for aggregated-root modules)
  app.post("/api/sessions/:id/validate-aggregated-resources", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const { description, childModuleResources } = req.body;
      
      if (!description || !childModuleResources || !Array.isArray(childModuleResources) || childModuleResources.length === 0) {
        return res.status(400).json({ 
          error: 'Description and child module resources are required',
          details: ['Please provide a description of the resources you want to create and ensure the child module has been reviewed.']
        });
      }

      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.moduleApproach !== 'aggregated-root') {
        return res.status(400).json({ 
          error: 'This endpoint is only for aggregated-root modules',
          details: ['Resource validation is only required for aggregated root modules.']
        });
      }

      // Use session cloud provider if available
      const sessionProvider = session.cloudProvider || session.detectedCloudProvider;
      
      // NEW: Use AI to extract resources from the description for much better accuracy
      console.log(`\n🤖 AI Extracting resources from description: "${description}"`);
      const requestedResources = await openaiService.extractResourcesFromDescription(
        description, 
        sessionProvider as 'azure' | 'aws' | 'gcp' | null
      );
      console.log(`   ✅ AI Identified ${requestedResources.length} resource(s): ${requestedResources.join(', ')}`);

      if (requestedResources.length === 0) {
        return res.status(400).json({
          error: 'No resources detected',
          details: ['We could not identify any specific cloud resources in your description. Please be more specific (e.g., "Create a storage account and a function app").']
        });
      }

      // Extract available resources from child module
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

      // All resources are available
      return res.json({
        valid: true,
        message: 'All requested resources are available in the child module',
        requestedResources,
        availableResources
      });
    } catch (error: any) {
      console.error('Error validating aggregated resources:', error);
      return res.status(500).json({
        error: 'Failed to validate resources',
        details: error.message || 'Unknown error occurred'
      });
    }
  });

  // Scan child module repository to extract available resources
  app.post("/api/sessions/:id/scan-child-module", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const { repositoryId, provider } = req.body;
      
      if (!repositoryId || !provider) {
        return res.status(400).json({ error: 'Repository ID and provider are required' });
      }

      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Get repository name from ID
      const repos = await mcpClient.listRepositories(provider as MCPProvider);
      const repo = repos.find(r => r.id === repositoryId || r.name === repositoryId);
      
      if (!repo) {
        return res.status(404).json({ error: 'Repository not found' });
      }

      console.log(`\n📦 Scanning child module repository: ${repo.name}`);

      // Scan repository files
      const files = await mcpClient.scanRepositoryFiles(
        provider as MCPProvider,
        repo.name,
        'main'
      );

      // Filter Terraform files
      const terraformFiles = files.filter(f => 
        f.path.toLowerCase().endsWith('.tf') && 
        !f.path.toLowerCase().endsWith('.tfvars')
      );

      if (terraformFiles.length === 0) {
        return res.json({
          resources: [],
          message: 'No Terraform files found in the child module repository'
        });
      }

      // Parse resources from Terraform files
      const { parseResources } = await import('../diagram/resource-relationship-parser');
      const parsedResources = parseResources(
        terraformFiles.map(f => ({
          fileName: f.path,
          content: f.content
        }))
      );

      // Extract unique resource types
      const uniqueResourceTypes = new Set<string>();
      parsedResources.forEach(r => {
        uniqueResourceTypes.add(r.type);
      });

      const resources = Array.from(uniqueResourceTypes).map(type => ({
        type,
        name: type, // Use type as name for display
        description: `Available ${type} resource from child module`
      }));

      console.log(`   ✅ Found ${resources.length} unique resource type(s): ${resources.map(r => r.type).join(', ')}`);

      return res.json({
        resources,
        totalResources: parsedResources.length,
        message: `Found ${resources.length} available resource type(s) in the child module`
      });
    } catch (error: any) {
      console.error('Error scanning child module:', error);
      return res.status(500).json({
        error: 'Failed to scan child module',
        details: error.message || 'Unknown error occurred'
      });
    }
  });

  // Scan repository for existing Terraform configuration
  app.post("/api/sessions/:id/scan-repository", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const { refresh = false } = req.body || {}; // Option to clear existing files first
      const session = await storage.getSession(sessionId);
      
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (!session.provider || !session.repositoryName) {
        return res.status(400).json({ error: 'Provider and repository must be selected before scanning' });
      }

      // If refresh is true, clear existing files first to start fresh
      if (refresh) {
        console.log(`\n🔄 Refresh mode: Clearing existing files before scanning...`);
        const filesBefore = await storage.getFilesBySession(sessionId);
        const filesCleared = filesBefore.length;
        await storage.deleteFilesBySession(sessionId);
        console.log(`   ✅ Cleared ${filesCleared} existing file(s) from session storage`);
        console.log(`   📥 Will fetch fresh files from repository`);
      }

      const files = await mcpClient.scanRepositoryFiles(
        session.provider as MCPProvider,
        session.repositoryName,
        'main'
      );

      // CRITICAL: Log ALL files returned from repository (before any processing)
      console.log(`\n📥 Raw files returned from repository: ${files.length} file(s)`);
      files.forEach((f, i) => {
        console.log(`   ${i + 1}. "${f.path}" (${f.content.length} chars)`);
      });
      
      // Check specifically for tfvars files
      const tfvarsInRawFiles = files.filter(f => f.path.toLowerCase().endsWith('.tfvars'));
      console.log(`\n   🔍 Tfvars files in raw repository response: ${tfvarsInRawFiles.length}`);
      if (tfvarsInRawFiles.length > 0) {
        tfvarsInRawFiles.forEach(f => {
          console.log(`      ✅ "${f.path}" (${f.content.length} chars)`);
        });
      } else {
        console.error(`      ⚠️⚠️⚠️  NO tfvars files found in repository response!`);
        console.error(`      ⚠️  This means the MCP client is not returning tfvars files from the repository.`);
        console.error(`      ⚠️  Check if dev.terraform.tfvars exists in the repository.`);
      }

      // Step 1: Regex-based analysis (fast, reliable for common cases)
      const regexAnalysis = analyzeTerraformFiles(files);
      
      // Step 2: AI-based analysis (intelligent, handles edge cases)
      let aiAnalysis: {
        cloudProvider: 'azure' | 'aws' | 'gcp' | null;
        moduleType: 'child' | 'root' | 'empty' | null;
        summary: string;
        detectedResources: string[];
      } | null = null;
      
      if (files.length > 0) {
        try {
          console.log('\n🤖 Running AI analysis on repository files...');
          aiAnalysis = await openaiService.analyzeRepositoryFiles(files);
          console.log('✅ AI analysis completed');
        } catch (error: any) {
          console.error('⚠️  AI analysis failed, using regex-based detection:', error.message);
          // Continue with regex analysis only
        }
      }

      // Combine results: Prefer AI analysis if available, fallback to regex
      const analysis = {
        cloudProvider: aiAnalysis?.cloudProvider || regexAnalysis.cloudProvider,
        moduleType: aiAnalysis?.moduleType || regexAnalysis.moduleType,
        hasResources: regexAnalysis.hasResources,
        hasModules: regexAnalysis.hasModules,
        providerBlocks: regexAnalysis.providerBlocks,
        backend: regexAnalysis.backend,
        // Additional AI insights
        aiSummary: aiAnalysis?.summary,
        aiDetectedResources: aiAnalysis?.detectedResources || []
      };

      console.log('\n📊 Combined Analysis Results:');
      console.log(`   Cloud Provider: ${analysis.cloudProvider || 'Not detected'} ${aiAnalysis ? '(AI)' : '(Regex)'}`);
      console.log(`   Module Type: ${analysis.moduleType || 'Not detected'} ${aiAnalysis ? '(AI)' : '(Regex)'}`);
      if (aiAnalysis?.summary) {
        console.log(`   AI Summary: ${aiAnalysis.summary.substring(0, 150)}...`);
      }

      // Extract existing resources for display
      const existingResources: Array<{ type: string; name: string; file: string }> = [];
      for (const file of files) {
        if (!file.path.endsWith('.tf')) continue;
        
        // Match resource blocks: resource "azurerm_storage_account" "name" { ... }
        const resourcePattern = /resource\s+"([^"]+)"\s+"([^"]+)"/g;
        let match;
        while ((match = resourcePattern.exec(file.content)) !== null) {
          existingResources.push({
            type: match[1],
            name: match[2],
            file: file.path
          });
        }
      }

      const updates: Partial<InsertSession> = {
        isExistingRepo: files.length > 0 ? 'true' : 'false',
        detectedCloudProvider: analysis.cloudProvider,
        detectedModuleType: analysis.moduleType,
        detectedTerraformFiles: files.map(f => f.path),
        // Backend configuration tracking
        hasBackend: analysis.backend.hasBackend ? 'true' : 'false',
        backendType: analysis.backend.backendType,
        backendStorageAccount: analysis.backend.storageAccountName,
        backendResourceGroup: analysis.backend.resourceGroupName,
        backendContainer: analysis.backend.containerName,
        backendStateKey: analysis.backend.stateFileKey,
      };

      if (analysis.cloudProvider) {
        updates.cloudProvider = analysis.cloudProvider;
      }

      await storage.updateSession(sessionId, updates);

      // CRITICAL: Store ALL files in session storage for display/review
      // The UI needs to see ALL files, not just filtered ones
      // Filtering will only happen during generation for matching logic
      if (files.length > 0) {
        console.log(`\n💾 Storing ALL ${files.length} file(s) from repository in session storage...`);
        console.log(`   Session ID: ${sessionId}`);
        console.log(`   This includes ALL files for review (not filtered)`);
        
        // Get existing session files to avoid duplicates
        const existingSessionFiles = await storage.getFilesBySession(sessionId);
        console.log(`   Existing files in session: ${existingSessionFiles.length}`);
        const existingFilesMap = new Map<string, GeneratedFile>();
        existingSessionFiles.forEach(f => {
          existingFilesMap.set(f.fileName.toLowerCase(), f);
          console.log(`      - ${f.fileName} (ID: ${f.id})`);
        });
        
        const storedFileIds: string[] = [];
        for (const repoFile of files) {
          const fileName = repoFile.path.split('/').pop() || repoFile.path;
          console.log(`   📄 Processing file from repo: "${repoFile.path}" → fileName: "${fileName}"`);
          const existingFile = existingFilesMap.get(fileName.toLowerCase());
          
          if (existingFile) {
            // Update existing file with latest repository content
            console.log(`   ✅ Updating ${fileName} in session storage (ID: ${existingFile.id})`);
            await storage.updateFile(existingFile.id, repoFile.content);
            storedFileIds.push(existingFile.id);
          } else {
            // Create new file in session storage
            console.log(`   ➕ Creating ${fileName} in session storage`);
            const created = await storage.createFile({
              sessionId,
              fileName: fileName,
              content: repoFile.content,
            });
            storedFileIds.push(created.id);
            console.log(`      ✅ Created with ID: ${created.id}`);
          }
        }
        
        // VERIFY: Re-fetch files to confirm they're stored
        const verifyFiles = await storage.getFilesBySession(sessionId);
        console.log(`\n   ✅ Verification: ${verifyFiles.length} file(s) now in session storage`);
        verifyFiles.forEach(f => {
          console.log(`      - ${f.fileName} (ID: ${f.id}, ${f.content.length} chars)`);
        });
        
        // CRITICAL: Check if tfvars files are included
        const tfvarsFiles = verifyFiles.filter(f => f.fileName.toLowerCase().endsWith('.tfvars'));
        console.log(`\n   📋 Tfvars files in session storage: ${tfvarsFiles.length}`);
        tfvarsFiles.forEach(f => {
          console.log(`      ✅ ${f.fileName} (${f.content.length} chars)`);
        });
        
        if (verifyFiles.length === 0) {
          console.error(`\n   ❌❌❌ CRITICAL: Files were NOT stored! Session storage is empty!`);
          console.error(`   This is a BUG - files should be in session storage now.`);
        } else {
          console.log(`   ✅ ALL files successfully stored in session storage for review and matching`);
        }
      } else {
        console.log(`\n📋 No files found in repository`);
      }
      
      console.log(`\n📋 Repository scan completed.`);

      const result = {
        isExisting: files.length > 0,
        cloudProvider: analysis.cloudProvider,
        moduleType: analysis.moduleType,
        terraformFiles: files.map(f => f.path),
        terraformFilesWithContent: files, // Include full file contents for review
        existingResources: existingResources, // Include extracted resources
        hasResources: analysis.hasResources,
        hasModules: analysis.hasModules,
        providerBlocks: analysis.providerBlocks,
        backend: analysis.backend,
        refreshed: refresh, // Indicate if this was a refresh operation
        filesStored: (await storage.getFilesBySession(sessionId)).length
      };

      res.json(result);
    } catch (error: any) {
      console.error('Error scanning repository:', error);
      const errorMessage = error?.message || 'Failed to scan repository';
      const errorDetails = error?.stack || error?.toString();
      console.error('Error details:', errorDetails);
      res.status(500).json({ 
        error: 'Failed to scan repository',
        details: errorMessage,
        ...(process.env.NODE_ENV === 'development' && { stack: errorDetails })
      });
    }
  });
}

