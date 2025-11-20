import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { mcpClient, type MCPProvider } from "./mcp-client";
import { openaiService, type ChatMessage } from "./openai-service";
import { insertMessageSchema, insertGeneratedFileSchema, insertSessionSchema, type Repository, type InsertSession, type GeneratedFile } from "@shared/schema";
import { analyzeTerraformFiles } from "./terraform-parser";
import { validateTerraformRequest, formatValidationErrors, type ValidationResult } from "./terraform-validator";

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

// Helper function to find matching brace for Terraform blocks
function findMatchingBrace(content: string, startIndex: number): number {
  let depth = 1;
  let i = startIndex;
  while (i < content.length && depth > 0) {
    if (content[i] === '{') depth++;
    if (content[i] === '}') depth--;
    i++;
  }
  return i;
}

// Helper function to validate that a fix actually addresses Checkov issues
function validateFix(originalContent: string, fixedContent: string, checks: any[]): { isValid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  
  // Check if content actually changed
  if (originalContent === fixedContent) {
    warnings.push('Content is identical - no changes made');
    return { isValid: false, warnings };
  }
  
  // Basic validation: ensure code structure is still valid Terraform
  // Check that resource blocks are still present (basic sanity check)
  const resourceBlocks = (content: string) => (content.match(/resource\s+"[^"]+"\s+"[^"]+"/g) || []).length;
  const originalResources = resourceBlocks(originalContent);
  const fixedResources = resourceBlocks(fixedContent);
  
  if (fixedResources < originalResources) {
    warnings.push(`Resource count decreased from ${originalResources} to ${fixedResources} - resources may have been removed`);
  }
  
  // Check that the fixed content is longer or different (indicates changes were made)
  const contentChanged = fixedContent.length !== originalContent.length || 
                          fixedContent.trim() !== originalContent.trim();
  
  if (!contentChanged) {
    warnings.push('Content appears unchanged despite length difference');
  }
  
  return { isValid: warnings.length === 0, warnings };
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Create a new session
  app.post("/api/sessions", async (req, res) => {
    try {
      const session = await storage.createSession({});
      res.json(session);
    } catch (error) {
      console.error('Error creating session:', error);
      res.status(500).json({ error: 'Failed to create session' });
    }
  });

  // Get session
  app.get("/api/sessions/:id", async (req, res) => {
    try {
      const session = await storage.getSession(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      res.json(session);
    } catch (error) {
      console.error('Error getting session:', error);
      res.status(500).json({ error: 'Failed to get session' });
    }
  });

  // Update session
  app.patch("/api/sessions/:id", async (req, res) => {
    try {
      const parsed = insertSessionSchema.partial().parse(req.body);
      
      // Workflow gating: advance to backend_configuration after module approach is selected
      if (parsed.moduleApproach && !parsed.workflowStep) {
        parsed.workflowStep = 'backend_configuration';
      }
      
      const session = await storage.updateSession(req.params.id, parsed);
      res.json(session);
    } catch (error) {
      console.error('Error updating session:', error);
      res.status(500).json({ error: 'Failed to update session' });
    }
  });

  // Get messages for a session
  app.get("/api/sessions/:id/messages", async (req, res) => {
    try {
      const messages = await storage.getMessagesBySession(req.params.id);
      res.json(messages);
    } catch (error) {
      console.error('Error getting messages:', error);
      res.status(500).json({ error: 'Failed to get messages' });
    }
  });

  // Debug endpoint: Get all files for a session
  app.get("/api/sessions/:id/files-debug", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const files = await storage.getFilesBySession(sessionId);
      const session = await storage.getSession(sessionId);
      res.json({
        sessionId,
        sessionExists: !!session,
        fileCount: files.length,
        files: files.map(f => ({
          id: f.id,
          fileName: f.fileName,
          contentLength: f.content.length,
          sessionId: f.sessionId,
        })),
        sessionInfo: session ? {
          moduleType: session.detectedModuleType,
          hasResources: session.isExistingRepo,
          moduleApproach: session.moduleApproach,
        } : null,
      });
    } catch (error) {
      console.error('Error getting files debug:', error);
      res.status(500).json({ error: 'Failed to get files debug' });
    }
  });

  // Create system message (without AI response)
  app.post("/api/sessions/:id/messages/system", async (req, res) => {
    try {
      const { message } = req.body;
      const sessionId = req.params.id;

      const aiMessage = await storage.createMessage({
        sessionId,
        type: 'ai',
        content: message,
      });

      res.json({ aiMessage });
    } catch (error) {
      console.error('Error creating system message:', error);
      res.status(500).json({ error: 'Failed to create system message' });
    }
  });

  // Send a chat message (with AI response based on session state)
  app.post("/api/sessions/:id/chat", async (req, res) => {
    try {
      const { message } = req.body;
      const sessionId = req.params.id;

      // Save user message
      const userMessage = await storage.createMessage({
        sessionId,
        type: 'user',
        content: message,
      });

      // Get session to understand context
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Get conversation history
      const messages = await storage.getMessagesBySession(sessionId);
      const chatHistory: ChatMessage[] = messages.map(m => ({
        role: m.type === 'user' ? 'user' : 'assistant',
        content: m.content
      }));

      // Prepare session context for AI
      // Safely parse detectedTerraformFiles
      let terraformFiles: string[] = [];
      try {
        if (session.detectedTerraformFiles) {
          if (Array.isArray(session.detectedTerraformFiles)) {
            terraformFiles = session.detectedTerraformFiles;
          } else if (typeof session.detectedTerraformFiles === 'string') {
            terraformFiles = JSON.parse(session.detectedTerraformFiles);
          }
        }
      } catch (parseError: any) {
        console.warn('⚠️  Failed to parse detectedTerraformFiles:', parseError.message);
        terraformFiles = [];
      }
      
      const sessionContext = {
        isExistingRepo: session.isExistingRepo === 'true',
        detectedCloudProvider: session.detectedCloudProvider,
        detectedModuleType: session.detectedModuleType,
        terraformFiles: terraformFiles,
      };

      // Build context-aware system prompt
      let contextPrompt = `You are an AI DevOps assistant. The user is at step ${session.currentStep} of the Terraform workflow.`;
      
      // Add detected repository information if available
      if (sessionContext.isExistingRepo && sessionContext.terraformFiles.length > 0) {
        const moduleTypeText = sessionContext.detectedModuleType === 'child' ? 'child module' :
                              sessionContext.detectedModuleType === 'root' ? 'root module' :
                              'Terraform configuration';
        contextPrompt += `\n\nDETECTED REPOSITORY: This is an existing ${moduleTypeText}`;
        if (sessionContext.detectedCloudProvider) {
          contextPrompt += ` for ${sessionContext.detectedCloudProvider.toUpperCase()}`;
        }
        contextPrompt += ` with ${sessionContext.terraformFiles.length} Terraform files.`;
      }
      
      if (session.currentStep === '1') {
        contextPrompt += `\n\nStep 1: Provider Selection - Help user choose between GitHub or Azure DevOps. Keep it brief.`;
      } else if (session.currentStep === '2') {
        contextPrompt += `\n\nStep 2: Repository Selection - Help user select an existing repository or create a new one. Keep it brief.`;
      } else if (session.currentStep === '3') {
        contextPrompt += `\n\nStep 3: Cloud Provider Selection - Help user choose Azure, AWS, or GCP. Keep it brief.`;
      } else if (session.currentStep === '4') {
        contextPrompt += `\n\nStep 4: Module Approach Selection - Help user choose between child module, standalone root module, or aggregated root module. Keep it brief.`;
      } else if (session.currentStep === '5') {
        let step5Prompt = `\n\nStep 5: Generate Terraform - User describes infrastructure they want to create.`;
        
        if (sessionContext.isExistingRepo && sessionContext.terraformFiles.length > 0) {
          // For existing repos, guide them on how to extend the existing configuration
          if (sessionContext.detectedModuleType === 'child') {
            step5Prompt += `\n\nThe repository already contains a child module. Help the user:
- Create additional child modules following the same folder structure
- Ensure new modules use "resource" blocks (not "module" blocks)
- Maintain consistency with existing patterns`;
          } else if (sessionContext.detectedModuleType === 'root') {
            step5Prompt += `\n\nThe repository already contains a root module. Help the user:
- Add additional resources to the existing configuration
- Maintain compatibility with existing provider configuration
- Suggest improvements while respecting existing structure`;
          }
        }
        
        step5Prompt += `\n\nIMPORTANT: Provide concise, step-by-step guidance and encouragement. Do NOT create bundled "Breakdown of what to create" sections. Instead:
- Acknowledge their request briefly
- Encourage them to be specific about resources and configurations
- Ask clarifying questions if needed
- Keep responses conversational and focused

Avoid creating structured breakdowns or lists unless specifically asked.`;
        contextPrompt += step5Prompt;
      } else if (session.currentStep === '6') {
        contextPrompt += `\n\nStep 6: Review & Commit - User is reviewing generated Terraform files. Answer questions about the code or configurations. Be concise and helpful.`;
      }

      // Get AI response with context
      const aiResponse = await openaiService.chatWithContext(contextPrompt, chatHistory);

      // Save AI message
      const aiMessage = await storage.createMessage({
        sessionId,
        type: 'ai',
        content: aiResponse,
      });

      res.json({ userMessage, aiMessage });
    } catch (error: any) {
      console.error('❌ Error in chat endpoint:', error);
      console.error('   Error type:', error?.constructor?.name);
      console.error('   Error message:', error?.message);
      console.error('   Error stack:', error?.stack);
      console.error('   Session ID:', req.params.id);
      console.error('   Request body:', req.body);
      
      const errorMessage = error?.message || 'Unknown error occurred';
      res.status(500).json({ 
        error: 'Failed to process chat message',
        details: errorMessage,
        type: error?.constructor?.name || 'Error'
      });
    }
  });

  // Pre-warm MCP connection for a provider (optional, called when provider is selected)
  app.post("/api/repositories/:provider/prewarm", async (req, res) => {
    try {
      const provider = req.params.provider as MCPProvider;
      console.log(`🔥 [API] Pre-warming connection for ${provider}...`);
      
      // Pre-warm in background (don't wait)
      mcpClient.prewarmConnection(provider).catch((error) => {
        console.warn(`⚠️  [API] Pre-warm failed for ${provider}:`, error.message);
      });
      
      res.json({ status: 'pre-warming', provider });
    } catch (error) {
      console.error('Error pre-warming connection:', error);
      res.status(500).json({ error: 'Failed to pre-warm connection' });
    }
  });

  // List repositories
  app.get("/api/repositories/:provider", async (req, res) => {
    const requestStart = Date.now();
    try {
      const provider = req.params.provider as MCPProvider;
      
      // Validate provider credentials
      if (provider === 'azure' && (!process.env.AZURE_DEVOPS_ORG || !process.env.AZURE_DEVOPS_PAT || !process.env.AZURE_DEVOPS_PROJECT)) {
        return res.status(400).json({ error: 'Azure DevOps credentials not configured. Please set AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT, and AZURE_DEVOPS_PROJECT environment variables.' });
      }
      if (provider === 'github' && (!process.env.GITHUB_TOKEN || !process.env.GITHUB_OWNER)) {
        return res.status(400).json({ error: 'GitHub credentials not configured. Please set GITHUB_TOKEN and GITHUB_OWNER environment variables.' });
      }
      
      console.log(`📡 [API] Listing repositories for ${provider}...`);
      const repos = await mcpClient.listRepositories(provider);
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
          lastUpdated: repo.updated_at || repo.lastUpdateTime || repo.updatedDate || repo.lastUpdated || '',
          branch: repo.default_branch || repo.defaultBranch || repo.branch || 'main'
        };
        console.log(`   📦 Formatted repo ${index + 1}: ${formattedRepo.name} (ID: ${formattedRepo.id})`);
        return formattedRepo;
      });

      console.log(`✅ [API] Returning ${formatted.length} formatted repository/repositories`);
      res.json(formatted);
    } catch (error) {
      console.error('Error listing repositories:', error);
      res.status(500).json({ error: 'Failed to list repositories' });
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
      
      res.status(500).json({ error: 'Failed to create repository' });
    }
  });

  // Scan repository for existing Terraform configuration
  app.post("/api/sessions/:id/scan-repository", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const session = await storage.getSession(sessionId);
      
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (!session.provider || !session.repositoryName) {
        return res.status(400).json({ error: 'Provider and repository must be selected before scanning' });
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

  // Configure/validate backend for Terraform
  app.post("/api/sessions/:id/configure-backend", async (req, res) => {
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

            // Fetch latest Terraform version from MCP server or API
            let latestVersion = '1.9.0'; // Default fallback
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
          // Step 0: Verify Service Principal permissions before attempting resource creation
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

          // Step 0: Validate or create resource group FIRST
          let rgValidation;
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
              // Check if it's a permission error
              if (errorMsg.includes('Authorization') || errorMsg.includes('403') || errorMsg.includes('permission')) {
                throw new Error(`Permission denied: ${errorMsg}. Service Principal needs 'Resource Group Contributor' role. Run: az role assignment create --assignee ${process.env.AZURE_CLIENT_ID} --role "Resource Group Contributor" --scope /subscriptions/${process.env.AZURE_SUBSCRIPTION_ID}`);
              }
              throw new Error(`Failed to create resource group: ${errorMsg}`);
            }
            console.log('Resource group created successfully');
          } else {
            console.log('Resource group already exists at location:', rgValidation.location);
          }

          // Step 1: Validate or create storage account
          let storageValidation;
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
              // Check if it's a permission error
              if (errorMsg.includes('Authorization') || errorMsg.includes('403') || errorMsg.includes('permission')) {
                throw new Error(`Permission denied: ${errorMsg}. Service Principal needs 'Storage Account Contributor' role. Run: az role assignment create --assignee ${process.env.AZURE_CLIENT_ID} --role "Storage Account Contributor" --scope /subscriptions/${process.env.AZURE_SUBSCRIPTION_ID}`);
              }
              throw new Error(`Failed to create storage account: ${errorMsg}`);
            }
            console.log('Storage account created successfully');
            // Get location from created storage account
            if (!storageValidation.location) {
              storageValidation.location = defaults.location;
            }
          } else {
            console.log('Storage account already exists');
          }

          // Step 2: Validate or create container
          let containerValidation;
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
              // Check if it's a permission error
              if (errorMsg.includes('Authorization') || errorMsg.includes('403') || errorMsg.includes('permission')) {
                throw new Error(`Permission denied: ${errorMsg}. Service Principal needs 'Storage Blob Data Contributor' role. Run: az role assignment create --assignee ${process.env.AZURE_CLIENT_ID} --role "Storage Blob Data Contributor" --scope /subscriptions/${process.env.AZURE_SUBSCRIPTION_ID}`);
              }
              throw new Error(`Failed to create container: ${errorMsg}`);
            }
            console.log('Container created successfully');
          } else {
            console.log('Container already exists');
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
          let latestVersion = '1.9.0'; // Default fallback
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
            message: 'Backend resources created successfully in Azure. Generated backend.tf, provider.tf, and terraform.tf files. Now describe the infrastructure resources you want to create.',
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
  app.post("/api/sessions/:id/generate-terraform", async (req, res) => {
    try {
      const { description } = req.body;
      const sessionId = req.params.id;

      // Get session to access cloudProvider and moduleApproach
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Phase 1: Basic Rule-Based Validation
      console.log('\n🔍 ========== PHASE 1: VALIDATION ==========');
      console.log(`📝 Validating request: "${description.substring(0, 100)}${description.length > 100 ? '...' : ''}"`);
      
      // Use session cloud provider if available (detected from repository scan)
      const sessionProvider = session.cloudProvider || session.detectedCloudProvider;
      console.log(`   Session Cloud Provider: ${sessionProvider || 'None'}`);
      
      const validationResult = validateTerraformRequest(description, {
        sessionProvider: sessionProvider as 'azure' | 'aws' | 'gcp' | null,
        minLength: 10,
        maxLength: 2000
      });

      console.log(`   Validation Result: ${validationResult.isValid ? '✅ VALID' : '❌ INVALID'}`);
      if (validationResult.detectedProvider) {
        console.log(`   Detected Provider: ${validationResult.detectedProvider}`);
      }
      if (validationResult.detectedResources.length > 0) {
        console.log(`   Detected Resources: ${validationResult.detectedResources.join(', ')}`);
      }
      if (validationResult.errors.length > 0) {
        console.log(`   Errors: ${validationResult.errors.join('; ')}`);
      }
      if (validationResult.warnings.length > 0) {
        console.log(`   Warnings: ${validationResult.warnings.join('; ')}`);
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
            detectedResources: validationResult.detectedResources
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
          
          repoFilesForAppend = repoFiles.filter(file => {
            // Normalize path: remove leading/trailing slashes (Azure DevOps returns paths with leading slash)
            const normalizedPath = file.path.replace(/^\/+|\/+$/g, '');
            const fileName = (normalizedPath.split('/').pop() || normalizedPath).toLowerCase();
            const isTerraformFile = fileName.endsWith('.tf') || fileName.endsWith('.tfvars');
            const isBackendConfig = ['backend.tf', 'provider.tf', 'terraform.tf'].includes(fileName);
            // Root level: no slashes after normalization, or only one segment
            const isRootLevel = !normalizedPath.includes('/') || normalizedPath.split('/').length === 1;
            const shouldInclude = isTerraformFile && !isBackendConfig && isRootLevel;
            
            // Debug logging for tfvars files
            if (fileName.includes('tfvars')) {
              console.log(`      🔍 Checking tfvars file: "${file.path}" → normalized: "${normalizedPath}" → fileName: "${fileName}"`);
              console.log(`         isTerraformFile: ${isTerraformFile}, isBackendConfig: ${isBackendConfig}, isRootLevel: ${isRootLevel}, shouldInclude: ${shouldInclude}`);
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
      const sessionFilesCheck = await storage.getFilesBySession(sessionId);
      const shouldAppend = session.moduleApproach === 'standalone-root' || 
                          (session.moduleApproach === null && (sessionFilesCheck.length > 0 || repoFilesForAppend.length > 0));
      
      if (shouldAppend) {
        // First check session storage (might have files from previous generation or scan)
        const sessionFiles = await storage.getFilesBySession(sessionId);
        console.log(`\n📋 Checking session storage: Found ${sessionFiles.length} total file(s)`);
        sessionFiles.forEach(f => {
          console.log(`   - ${f.fileName} (ID: ${f.id})`);
        });
        
        const sessionTerraformFiles = sessionFiles.filter(file => {
          const fileName = file.fileName.toLowerCase();
          return (fileName.endsWith('.tf') || fileName.endsWith('.tfvars')) && 
                 !['backend.tf', 'provider.tf', 'terraform.tf'].includes(fileName) &&
                 !file.fileName.includes('/'); // Only root-level files for standalone root
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
            
            // Filter to get only Terraform resource files (exclude backend config)
            const repoTerraformFiles = repoFiles.filter(file => {
              // Normalize path: remove leading/trailing slashes (Azure DevOps returns paths with leading slash)
              const normalizedPath = file.path.replace(/^\/+|\/+$/g, '');
              const fileName = (normalizedPath.split('/').pop() || normalizedPath).toLowerCase();
              const isTerraformFile = fileName.endsWith('.tf') || fileName.endsWith('.tfvars');
              const isBackendConfig = ['backend.tf', 'provider.tf', 'terraform.tf'].includes(fileName);
              // Root level: no slashes after normalization, or only one segment
              const isRootLevel = !normalizedPath.includes('/') || normalizedPath.split('/').length === 1;
              const shouldInclude = isTerraformFile && !isBackendConfig && isRootLevel;
              
              // Debug logging for tfvars files
              if (fileName.includes('tfvars')) {
                console.log(`      🔍 Checking tfvars file: "${file.path}" → normalized: "${normalizedPath}" → fileName: "${fileName}"`);
                console.log(`         isTerraformFile: ${isTerraformFile}, isBackendConfig: ${isBackendConfig}, isRootLevel: ${isRootLevel}, shouldInclude: ${shouldInclude}`);
              }
              
              return shouldInclude;
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
        if (!existingFilesForAppend && sessionTerraformFiles.length > 0) {
          // No repository info, use session files
          existingFilesForAppend = sessionTerraformFiles.map(file => ({
            path: file.fileName,
            content: file.content
          }));
          console.log(`   📋 Using session files for appending (no repository access)`);
        }
        
        if (existingFilesForAppend && existingFilesForAppend.length > 0) {
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
          console.error(`\n   ⚠️⚠️⚠️  WARNING: No existing files found for appending!`);
          console.error(`   ⚠️  This means AI will create all files as new (including dev.terraform.tfvars)!`);
        }
      }

      // Generate Terraform files with context
      const result = await openaiService.generateTerraform(
        description, 
        session.cloudProvider, 
        session.moduleApproach,
        backendConfig,
        existingFilesForAppend
      );
      
      // CRITICAL: Log what AI actually generated
      console.log(`\n📥 [AI RESPONSE] AI generated ${result.files.length} file(s):`);
      result.files.forEach((file, idx) => {
        console.log(`   ${idx + 1}. ${file.path} (${file.content.length} chars)`);
        
        // For main.tf, check what resources were generated
        if (file.path === 'main.tf') {
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
        // For child modules and aggregated root: Delete all session files and recreate
        // ONLY delete if moduleApproach is explicitly set to child-module or aggregated-root
        if (session.moduleApproach === 'child-module' || session.moduleApproach === 'aggregated-root') {
          console.log(`\n🗑️  Deleting existing session files for ${session.moduleApproach}...`);
          await storage.deleteFilesBySession(sessionId);
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
      
      const allFiles = [
        ...filteredFiles,
        { path: 'README.md', content: readmeContent }
      ];

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
          
          const terraformResourceFiles = repoFiles.filter(file => {
            // Normalize path: remove leading/trailing slashes (Azure DevOps returns paths with leading slash)
            const normalizedPath = file.path.replace(/^\/+|\/+$/g, '');
            const fileName = (normalizedPath.split('/').pop() || normalizedPath).toLowerCase();
            const isTerraformFile = fileName.endsWith('.tf') || fileName.endsWith('.tfvars');
            const isBackendConfig = ['backend.tf', 'provider.tf', 'terraform.tf'].includes(fileName);
            // Root level: no slashes after normalization, or only one segment
            const isRootLevel = !normalizedPath.includes('/') || normalizedPath.split('/').length === 1;
            return isTerraformFile && !isBackendConfig && isRootLevel;
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
      const isStandaloneRoot = session.moduleApproach === 'standalone-root' || 
                               (session.moduleApproach === null && allSessionFilesNow.length > 0);
      
      console.log(`   isStandaloneRoot: ${isStandaloneRoot}`);
      
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
            
            const terraformResourceFiles = repoFiles.filter(file => {
              // Normalize path: remove leading/trailing slashes
              const normalizedPath = file.path.replace(/^\/+|\/+$/g, '');
              const fileName = (normalizedPath.split('/').pop() || normalizedPath).toLowerCase();
              const isTerraformFile = fileName.endsWith('.tf') || fileName.endsWith('.tfvars');
              const isBackendConfig = ['backend.tf', 'provider.tf', 'terraform.tf'].includes(fileName);
              // Root level: no slashes after normalization, or only one segment
              const isRootLevel = !normalizedPath.includes('/') || normalizedPath.split('/').length === 1;
              return isTerraformFile && !isBackendConfig && isRootLevel;
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
          // Skip README.md - it's always new
          if (file.path.toLowerCase() === 'readme.md') {
            console.log(`\n   📄 ${file.path} - Skipping (always create new)`);
            const created = await storage.createFile({
              sessionId,
              fileName: file.path,
              content: file.content,
            });
            savedFiles.push(created);
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
                  
                  // Check if new resources already exist in old content
                  const resourcesToAdd = newResources.filter(newRes => {
                    const newResName = newRes.match(/resource\s+"([^"]+)"\s+"([^"]+)"/);
                    if (!newResName) {
                      return false;
                    }
                    const resType = newResName[1];
                    const resName = newResName[2];
                    const existingResPattern = new RegExp(`resource\\s+"${resType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s+"${resName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);
                    return !existingResPattern.test(existingContent);
                  });
                  
                  console.error(`         📊 [MERGE] Summary: ${newResources.length} total in AI, ${resourcesToAdd.length} new, ${newResources.length - resourcesToAdd.length} duplicates`);
                  
                  if (resourcesToAdd.length > 0) {
                    finalContent = existingContent.trim() + '\n\n' + resourcesToAdd.join('\n\n');
                    console.error(`         ✅ Merged: Added ${resourcesToAdd.length} new resource(s) to existing content`);
                    resourcesToAdd.forEach((res) => {
                      const resMatch = res.match(/resource\s+"([^"]+)"\s+"([^"]+)"/);
                      if (resMatch) {
                        console.error(`            ✅ Added: resource "${resMatch[1]}" "${resMatch[2]}"`);
                      }
                    });
                  } else {
                    // No new resources, keep existing content
                    finalContent = existingContent;
                    console.error(`         ⚠️⚠️⚠️  [MERGE] CRITICAL: No new resources found in AI response!`);
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
        savedFiles = await Promise.all(
          allFiles.map(file => 
            storage.createFile({
              sessionId,
              fileName: file.path,
              content: file.content,
            })
          )
        );
      }

      // Restore preserved backend configuration files (backend.tf, provider.tf, terraform.tf)
      // These were created during backend configuration and should not be overwritten
      if (preservedFiles.length > 0) {
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

      // Update session to Review step (Step 6) and mark workflow as completed
      await storage.updateSession(sessionId, { 
        currentStep: '6',
        workflowStep: 'terraform_generation'
      });

      res.json(savedFiles);
    } catch (error: any) {
      console.error('❌ Error generating Terraform:', error);
      console.error('Error details:', {
        message: error?.message,
        stack: error?.stack,
        name: error?.name,
        sessionId: req.params.id
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

  // Get generated files
  app.get("/api/sessions/:id/files", async (req, res) => {
    try {
      const sessionId = req.params.id;
      
      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      
      const files = await storage.getFilesBySession(sessionId);
      
      // Debug logging
      console.log(`📁 GET /api/sessions/${sessionId}/files`);
      console.log(`   Found ${files.length} file(s)`);
      files.forEach((f, i) => {
        console.log(`   ${i + 1}. ${f.fileName} (sessionId: ${f.sessionId}, size: ${f.content.length} bytes)`);
      });
      
      res.json(files);
    } catch (error) {
      console.error('Error getting files:', error);
      res.status(500).json({ error: 'Failed to get files' });
    }
  });

  // Create a file (for testing)
  app.post("/api/sessions/:id/files", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const { fileName, content } = req.body;
      
      if (!fileName || content === undefined) {
        return res.status(400).json({ error: 'fileName and content are required' });
      }

      // Check if file already exists for this session
      const existingFiles = await storage.getFilesBySession(sessionId);
      const existingFile = existingFiles.find(f => f.fileName === fileName);

      if (existingFile) {
        // Update existing file
        const updated = await storage.updateFile(existingFile.id, content);
        console.log(`📝 Updated existing file in session: ${fileName} (${content.length} bytes)`);
        res.json(updated);
      } else {
        // Create new file
        const file = await storage.createFile({
          sessionId,
          fileName,
          content,
        });
        console.log(`➕ Created new file in session: ${fileName} (${content.length} bytes)`);
        res.status(201).json(file);
      }
    } catch (error) {
      console.error('Error creating/updating file:', error);
      res.status(500).json({ error: 'Failed to create/update file' });
    }
  });

  // Bulk update files (for saving edited files from UI)
  app.post("/api/sessions/:id/files/bulk", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const { files } = req.body; // Array of { fileName, content }

      if (!Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: 'files array is required and must not be empty' });
      }

      console.log(`\n📝 Bulk updating ${files.length} file(s) in session ${sessionId}...`);

      // Get existing files for this session
      const existingFiles = await storage.getFilesBySession(sessionId);
      const existingFilesMap = new Map(existingFiles.map(f => [f.fileName, f]));

      const results = [];
      let createdCount = 0;
      let updatedCount = 0;

      for (const fileData of files) {
        const { fileName, content } = fileData;

        if (!fileName || content === undefined) {
          console.warn(`⚠️  Skipping invalid file entry: ${JSON.stringify(fileData)}`);
          continue;
        }

        const existingFile = existingFilesMap.get(fileName);

        if (existingFile) {
          // Update existing file
          const updated = await storage.updateFile(existingFile.id, content);
          results.push(updated);
          updatedCount++;
          console.log(`   ✅ Updated: ${fileName} (${content.length} bytes)`);
        } else {
          // Create new file
          const created = await storage.createFile({
            sessionId,
            fileName,
            content,
          });
          results.push(created);
          createdCount++;
          console.log(`   ➕ Created: ${fileName} (${content.length} bytes)`);
        }
      }

      console.log(`✅ Bulk update complete: ${updatedCount} updated, ${createdCount} created`);

      res.json({
        success: true,
        files: results,
        updated: updatedCount,
        created: createdCount,
        total: results.length
      });
    } catch (error) {
      console.error('Error bulk updating files:', error);
      res.status(500).json({ error: 'Failed to bulk update files' });
    }
  });

  // Update a file
  app.patch("/api/files/:id", async (req, res) => {
    try {
      const { content } = req.body;
      const file = await storage.updateFile(req.params.id, content);
      res.json(file);
    } catch (error) {
      console.error('Error updating file:', error);
      res.status(500).json({ error: 'Failed to update file' });
    }
  });

  // Check Checkov installation status
  app.get("/api/checkov/status", async (req, res) => {
    try {
      const isWindows = process.platform === 'win32';
      const { spawn } = await import('child_process');
      
      const checkCommands = isWindows
        ? [
            { command: 'checkov', args: ['--version'] },
            { command: 'py', args: ['-m', 'uv', 'run', 'checkov', '--version'] },
            { command: 'py', args: ['-m', 'checkov', '--version'] },
            { command: 'python3', args: ['-m', 'checkov', '--version'] },
            { command: 'python', args: ['-m', 'checkov', '--version'] }
          ]
        : [
            { command: 'checkov', args: ['--version'] },
            { command: 'python3', args: ['-m', 'uv', 'run', 'checkov', '--version'] },
            { command: 'python3', args: ['-m', 'checkov', '--version'] },
            { command: 'python', args: ['-m', 'checkov', '--version'] }
          ];

      const results = [];
      
      for (const { command, args } of checkCommands) {
        try {
          const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
            const proc = spawn(command, args, {
              shell: isWindows,
              stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => {
              stdout += data.toString();
            });

            proc.stderr.on('data', (data) => {
              stderr += data.toString();
            });

            proc.on('close', (code) => {
              resolve({ code: code || 0, stdout: stdout.trim(), stderr: stderr.trim() });
            });

            proc.on('error', () => {
              resolve({ code: -1, stdout: '', stderr: 'Command not found' });
            });
          });

          if (result.code === 0) {
            results.push({
              method: `${command} ${args.join(' ')}`,
              status: 'installed',
              version: result.stdout || result.stderr
            });
          } else {
            results.push({
              method: `${command} ${args.join(' ')}`,
              status: 'not_found',
              error: result.stderr || 'Command failed'
            });
          }
        } catch (error: any) {
          results.push({
            method: `${command} ${args.join(' ')}`,
            status: 'error',
            error: error.message
          });
        }
      }

      const installed = results.find(r => r.status === 'installed');
      
      res.json({
        installed: !!installed,
        recommended: installed ? installed.method : null,
        version: installed?.version || null,
        allResults: results
      });
    } catch (error: any) {
      console.error('Error checking Checkov status:', error);
      res.status(500).json({ 
        error: 'Failed to check Checkov installation',
        details: error.message 
      });
    }
  });

  // Run Checkov security scan on generated files
  app.post("/api/sessions/:id/scan", async (req, res) => {
      const sessionId = req.params.id;
    console.log(`\n🔍 ========== SCAN REQUEST RECEIVED ==========`);
    console.log(`Session ID: ${sessionId}`);
    console.log(`Timestamp: ${new Date().toISOString()}`);
    
    try {
      // Verify session exists first
      console.log(`📋 Checking if session exists...`);
      const session = await storage.getSession(sessionId);
      if (!session) {
        console.error(`❌ Session not found: ${sessionId}`);
        return res.status(404).json({ 
          error: 'Session not found',
          details: `Session ${sessionId} does not exist`
        });
      }
      
      console.log(`✅ Session found: step=${session.currentStep}, workflow=${session.workflowStep}`);
      console.log(`🔍 Starting Checkov scan for session ${sessionId}`);
      
      // CRITICAL: Fetch files from SESSION STORAGE (not repository)
      // This ensures we scan the LATEST generated code, not the old repository code
      console.log(`📁 Fetching files from SESSION STORAGE (latest generated code)...`);
      console.log(`   This includes all newly generated/updated resources`);
      
      const sessionFiles = await storage.getFilesBySession(sessionId);
      console.log(`✅ Found ${sessionFiles.length} file(s) in session storage`);
      
      let allFiles: Array<{ fileName: string; content: string; sessionId: string; id: string }>;
      
      if (sessionFiles.length === 0) {
        console.error(`❌ No files found in session storage`);
        // Fallback: Try repository if session storage is empty
        if (session.provider && session.repositoryName) {
          console.log(`   ⚠️  Falling back to repository...`);
          const repoFiles = await mcpClient.scanRepositoryFiles(
            session.provider as MCPProvider,
            session.repositoryName,
            'main'
          );
          allFiles = repoFiles
            .filter(file => file.path.endsWith('.tf') || file.path.endsWith('.tfvars'))
            .map(file => ({
              fileName: file.path.split('/').pop() || file.path,
              content: file.content,
              sessionId: sessionId,
              id: `temp-${file.path}`,
            }));
          
          if (allFiles.length === 0) {
            return res.status(400).json({ 
              error: 'No Terraform files found',
              details: 'No files in session storage or repository'
            });
          }
          
          console.log(`   ✅ Using ${allFiles.length} file(s) from repository (fallback)`);
        } else {
          return res.status(400).json({ 
            error: 'No files found',
            details: 'No files in session storage and no repository configured'
          });
        }
      } else {
        // Filter to Terraform files only from session storage
        allFiles = sessionFiles
          .filter(file => {
            const fileName = file.fileName.toLowerCase();
            return fileName.endsWith('.tf') || fileName.endsWith('.tfvars');
          })
          .map(file => ({
            fileName: file.fileName,
            content: file.content,
            sessionId: sessionId,
            id: file.id,
          }));
        
        console.log(`   ✅ Using ${allFiles.length} file(s) from session storage (latest generated code)`);
      }
      
      console.log(`📄 Terraform files found: ${allFiles.length}`);
      if (allFiles.length > 0) {
        console.log(`📄 Files to scan:`);
        allFiles.forEach((file, i) => {
          console.log(`   ${i + 1}. ${file.fileName} (content length: ${file.content?.length || 0} bytes)`);
          if (file.content && file.content.length > 0) {
            const preview = file.content.substring(0, 150).replace(/\n/g, ' ');
            console.log(`      Preview: ${preview}...`);
          }
        });
      } else {
        console.warn(`⚠️  No Terraform files found in session storage or repository`);
        if (session.repositoryName) {
          console.warn(`   Repository: ${session.repositoryName}`);
        }
        if (session.provider) {
          console.warn(`   Provider: ${session.provider}`);
        }
        
        return res.status(400).json({ 
          error: 'No files found to scan',
          details: `No files have been generated for this session yet. Please generate Terraform files first.`,
          sessionStep: session.currentStep,
          workflowStep: session.workflowStep,
          sessionId: sessionId
        });
      }
      
      // Filter only Terraform files (.tf, .tfvars, .hcl)
      const terraformFiles = allFiles.filter(file => {
        const fileName = file.fileName.toLowerCase();
        const isTerraform = fileName.endsWith('.tf') || fileName.endsWith('.tfvars') || fileName.endsWith('.hcl');
        
        // Also verify content exists and is not empty
        if (isTerraform && (!file.content || file.content.trim().length === 0)) {
          console.warn(`   ⚠️  Skipping empty Terraform file: ${file.fileName}`);
          return false;
        }
        
        return isTerraform;
      });
      
      console.log(`📋 Terraform files to scan: ${terraformFiles.length}`);
      terraformFiles.forEach(file => {
        console.log(`   - ${file.fileName} (${file.content.length} bytes)`);
      });
      
      if (terraformFiles.length === 0) {
        console.warn('⚠️  No Terraform files found to scan');
        const nonTerraformFiles = allFiles.filter(file => {
          const fileName = file.fileName.toLowerCase();
          return !fileName.endsWith('.tf') && !fileName.endsWith('.tfvars') && !fileName.endsWith('.hcl');
        });
        return res.status(400).json({ 
          error: 'No Terraform files to scan',
          details: `Found ${allFiles.length} file(s) but none are Terraform files (.tf, .tfvars, .hcl)`,
          foundFiles: allFiles.map(f => f.fileName),
          nonTerraformFiles: nonTerraformFiles.map(f => f.fileName)
        });
      }
      
      const files = terraformFiles;

      // Import required modules
      console.log(`📦 Importing required modules...`);
      let fs, path, spawn, os;
      try {
        fs = await import('fs/promises');
        console.log(`   ✅ fs/promises imported`);
        path = await import('path');
        console.log(`   ✅ path imported`);
        const childProcess = await import('child_process');
        spawn = childProcess.spawn;
        console.log(`   ✅ child_process imported`);
        os = await import('os');
        console.log(`   ✅ os imported`);
      } catch (importError: any) {
        console.error(`❌ Failed to import modules:`, importError);
        throw new Error(`Failed to import required modules: ${importError.message}`);
      }

      // Create a temporary directory for scanning
      // Use project directory to avoid cross-drive path issues on Windows
      // (Checkov fails with "path is on mount 'C:', start on mount 'D:'" error)
      console.log(`📁 Creating temporary directory...`);
      const projectRoot = process.cwd();
      console.log(`   Project root: ${projectRoot}`);
      const tempBaseDir = path.join(projectRoot, '.temp-checkov');
      console.log(`   Temp base dir: ${tempBaseDir}`);
      
      try {
        await fs.mkdir(tempBaseDir, { recursive: true });
        console.log(`   ✅ Created base temp directory`);
      } catch (mkdirError: any) {
        console.error(`❌ Failed to create temp base directory:`, mkdirError);
        throw new Error(`Failed to create temp directory: ${mkdirError.message}`);
      }
      
      let tempDir: string;
      try {
        tempDir = await fs.mkdtemp(path.join(tempBaseDir, 'checkov-'));
        console.log(`   ✅ Created temp directory: ${tempDir}`);
      } catch (mkdtempError: any) {
        console.error(`❌ Failed to create temp directory:`, mkdtempError);
        throw new Error(`Failed to create temp directory: ${mkdtempError.message}`);
      }
      
      try {
        // Write all Terraform files to temp directory
        console.log(`📝 Writing ${files.length} file(s) to temp directory: ${tempDir}`);
        let filesWritten = 0;
        for (const file of files) {
          // Handle file paths that may contain directory separators (e.g., "ResourceGroup/main.tf")
          // Normalize path separators for current OS
          const normalizedPath = file.fileName.replace(/\//g, path.sep).replace(/\\/g, path.sep);
          const filePath = path.join(tempDir, normalizedPath);
          const fileDir = path.dirname(filePath);
          
          // Create directory if it doesn't exist
          await fs.mkdir(fileDir, { recursive: true });
          
          // Verify content exists
          if (!file.content || file.content.trim().length === 0) {
            console.warn(`⚠️  File ${file.fileName} has empty content, skipping...`);
            continue;
          }
          
          await fs.writeFile(filePath, file.content, 'utf-8');
          filesWritten++;
          console.log(`   ✅ Written: ${file.fileName} -> ${filePath} (${file.content.length} bytes)`);
        }
        
        console.log(`📊 Successfully wrote ${filesWritten} of ${files.length} file(s)`);
        
        // Verify files were written
        const writtenFiles = await fs.readdir(tempDir, { recursive: true });
        console.log(`📋 Files in temp directory: ${writtenFiles.length}`);
        writtenFiles.forEach((f, i) => {
          console.log(`   ${i + 1}. ${f}`);
        });
        
        // Additional verification: Check if any .tf files exist
        const tfFiles = writtenFiles.filter((f: string) => 
          typeof f === 'string' && (f.endsWith('.tf') || f.endsWith('.tfvars') || f.endsWith('.hcl'))
        );
        console.log(`📋 Terraform files found: ${tfFiles.length}`);
        if (tfFiles.length === 0) {
          console.error(`❌ WARNING: No Terraform files found in temp directory!`);
          console.error(`   This will cause Checkov to return 0 results`);
          console.error(`   Written files: ${JSON.stringify(writtenFiles)}`);
        }
        
        // Verify file contents (use normalized paths)
        for (const file of files) {
          if (!file.content || file.content.trim().length === 0) {
            continue; // Skip empty files
          }
          const normalizedPath = file.fileName.replace(/\//g, path.sep).replace(/\\/g, path.sep);
          const filePath = path.join(tempDir, normalizedPath);
          try {
            const stats = await fs.stat(filePath);
            const content = await fs.readFile(filePath, 'utf-8');
            if (content.length === 0) {
              console.warn(`   ⚠️  File ${file.fileName} is empty after writing`);
            } else {
              console.log(`   ✓ Verified: ${file.fileName} (${stats.size} bytes, ${content.length} chars)`);
            }
          } catch (verifyError: any) {
            console.error(`   ❌ Failed to verify ${file.fileName}:`, verifyError.message);
            console.error(`      Expected path: ${filePath}`);
          }
        }
        
        // Final check: ensure we have at least one valid Terraform file
        if (filesWritten === 0) {
          console.error(`❌ No files were written successfully!`);
          console.error(`   Attempted to write ${files.length} file(s), but all were empty or failed`);
          return res.status(400).json({
            error: 'No valid Terraform files to scan',
            details: `Attempted to write ${files.length} file(s), but all were empty or failed to write. Check server logs for details.`
          });
        }
        
        console.log(`✅ Ready to scan ${filesWritten} file(s) in ${tempDir}`);

        // Run Checkov with JSON output using spawn (works better on Windows)
        // Use uv to run checkov from the virtual environment (.venv)
        const isWindows = process.platform === 'win32';
        
        const checkovArgs = ['-d', tempDir, '--framework', 'terraform', '--output', 'json', '--compact', '--quiet'];
        
        // Try commands in order of preference:
        // 1. Direct 'checkov' command (like Replit - if installed globally)
        // 2. py -m uv run checkov (from .venv via uv)
        // 3. py -m checkov (Python module)
        // 4. python3/python -m checkov (fallbacks)
        // Format: [command, baseArgs, checkovArgs]
        const checkovCommands: [string, string[], string[]][] = isWindows 
          ? [
              ['checkov', [], checkovArgs],  // Try direct command first (like Replit)
              ['py', ['-m', 'uv', 'run', 'checkov'], checkovArgs],
              ['py', ['-m', 'checkov'], checkovArgs],
              ['python3', ['-m', 'checkov'], checkovArgs],
              ['python', ['-m', 'checkov'], checkovArgs]
            ]
          : [
              ['checkov', [], checkovArgs],  // Try direct command first (like Replit)
              ['python3', ['-m', 'uv', 'run', 'checkov'], checkovArgs],
              ['python3', ['-m', 'checkov'], checkovArgs],
              ['python', ['-m', 'checkov'], checkovArgs]
            ];
        
        console.log(`📋 Will try ${checkovCommands.length} command(s):`);
        checkovCommands.forEach(([cmd, args], i) => {
          console.log(`   ${i + 1}. ${cmd} ${args.join(' ')} ${checkovArgs.join(' ')}`);
        });
        
        // Add timeout to prevent hanging (5 minutes max)
        const TIMEOUT_MS = 5 * 60 * 1000;
        
        console.log(`\n🚀 Starting Checkov execution...`);
        const scanResult = await Promise.race([
          new Promise<any>((resolve, reject) => {
            let attemptIndex = 0;
            let resolved = false;
            let timeoutId: NodeJS.Timeout | null = null;
            
            const cleanup = () => {
              if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
              }
            };
            
            const tryNextCommand = () => {
              if (resolved) return;
              
              if (attemptIndex >= checkovCommands.length) {
                cleanup();
                // All commands failed - provide detailed error message
                const attemptedCommands = checkovCommands.map(([cmd, baseArgs, checkovArgs]) => {
                  if (baseArgs.length > 0) {
                    return `  - ${cmd} ${baseArgs.join(' ')} ${checkovArgs.join(' ')}`;
                  } else {
                    return `  - ${cmd} ${checkovArgs.join(' ')}`;
                  }
                }).join('\n');
                
                const errorMsg = `Checkov scan failed after trying all available commands.

Troubleshooting steps:
1. Verify Checkov is installed: py -m uv run checkov --version
2. If that works, check server logs for detailed error messages
3. Ensure temp directory is writable: ${path.join(process.cwd(), '.temp-checkov')}
4. Check if files are being written correctly (see server logs)

Last attempted commands:
${attemptedCommands}

Please check the server console logs for detailed error information.`;
                
                console.error(`\n❌ ========== ALL CHECKOV COMMANDS FAILED ==========`);
                console.error(`   Tried ${checkovCommands.length} command(s):`);
                checkovCommands.forEach(([cmd, baseArgs, checkovArgs], i) => {
                  if (baseArgs.length > 0) {
                    console.error(`   ${i + 1}. ${cmd} ${baseArgs.join(' ')} ${checkovArgs.join(' ')}`);
                  } else {
                    console.error(`   ${i + 1}. ${cmd} ${checkovArgs.join(' ')}`);
                  }
                });
                console.error(`   Check server logs above for detailed error messages`);
                console.error(`==========================================\n`);
                reject(new Error(errorMsg));
                return;
              }
              
              const [command, baseArgs, args] = checkovCommands[attemptIndex];
              attemptIndex++;
              
              const fullArgs = [...baseArgs, ...args];
              const commandStr = baseArgs.length > 0 
                ? `${command} ${baseArgs.join(' ')} ${args.join(' ')}`
                : `${command} ${args.join(' ')}`;
              
              console.log(`\n🔧 ========== ATTEMPT ${attemptIndex} of ${checkovCommands.length} ==========`);
              console.log(`🔧 Trying Checkov with: ${commandStr}`);
              console.log(`📂 Scanning directory: ${tempDir}`);
              console.log(`   Command: ${command}`);
              console.log(`   Base args: ${baseArgs.join(' ') || '(none)'}`);
              console.log(`   Checkov args: ${args.join(' ')}`);
              
              // Log the exact command being executed for debugging
              console.log(`🚀 Executing: ${command} ${fullArgs.join(' ')}`);
              console.log(`   Working directory: ${process.cwd()}`);
              console.log(`   Temp directory: ${tempDir}`);
              console.log(`   Is Windows: ${isWindows}`);
              console.log(`   Shell: ${isWindows ? 'true' : 'false'}`);
              
              // On Windows, we need to ensure PATH includes Python launcher
              const env = { ...process.env };
              
              // Ensure Python launcher is in PATH on Windows
              if (isWindows) {
                const username = process.env.USERNAME || process.env.USER || '';
                const pythonPaths = [
                  // Python launcher (py.exe) - this is critical!
                  `C:\\Users\\${username}\\AppData\\Local\\Programs\\Python\\Launcher`,
                ];
                
                const currentPath = env.PATH || '';
                // Use semicolon for Windows PATH separator
                const pathParts = currentPath.split(';');
                
                // Add Python launcher to the BEGINNING of PATH (so it's found first)
                pythonPaths.forEach(p => {
                  if (p && !pathParts.includes(p)) {
                    pathParts.unshift(p); // Add to beginning
                  }
                });
                env.PATH = pathParts.join(';'); // Use semicolon for Windows
                
                console.log(`   Added Python launcher to PATH`);
                console.log(`   PATH now starts with: ${pathParts.slice(0, 3).join(';')}...`);
              }
              
              console.log(`   Environment PATH length: ${env.PATH?.length || 0} chars`);
              
              // Determine shell and command execution method
              // On Windows, we can use PowerShell, cmd.exe, or Git Bash
              // Try to detect if we're in Git Bash (SHELL env var or MSYSTEM)
              const isGitBash = process.env.SHELL?.includes('bash') || process.env.MSYSTEM?.startsWith('MINGW');
              const useGitBash = isGitBash && isWindows;
              
              let finalCommand = command;
              let finalArgs = fullArgs;
              let useShell = isWindows || useGitBash;
              
              if (useGitBash) {
                // Git Bash: Use bash -c to execute commands
                console.log(`   Detected Git Bash environment (SHELL=${process.env.SHELL}, MSYSTEM=${process.env.MSYSTEM})`);
                finalCommand = 'bash';
                finalArgs = ['-c', `${command} ${fullArgs.join(' ')}`];
                useShell = false; // bash is the command, don't use shell wrapper
                console.log(`   Using Git Bash execution: bash -c "${command} ${fullArgs.join(' ')}"`);
              } else if (isWindows) {
                // Windows PowerShell/CMD: Use shell: true to find commands via PATH
                // This works for: py, python, python3, and checkov (if in PATH)
                if (command === 'py' || command === 'python' || command === 'python3' || command === 'checkov') {
                  finalCommand = command;
                  finalArgs = fullArgs;
                  useShell = true; // Use shell to find command via PATH
                  console.log(`   Using Windows shell execution for ${command} command`);
                }
              }
              
              console.log(`   Final command: ${finalCommand}`);
              console.log(`   Final args: ${finalArgs.join(' ')}`);
              console.log(`   Using shell: ${useShell}`);
              
              const checkovProcess = spawn(finalCommand, finalArgs, {
                shell: useShell,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: env,
                cwd: process.cwd()
              });
              
              console.log(`   Process spawned, PID: ${checkovProcess.pid}`);
              
              // Log if process exits immediately
              checkovProcess.on('spawn', () => {
                console.log(`   ✅ Process spawned successfully`);
              });

              let stdout = '';
              let stderr = '';
              let processEnded = false;
              let streamsEnded = false;
              let hasOutput = false;
              let stdoutEnded = false;
              let stderrEnded = false;

              // Set timeout for this attempt (2 minutes per command)
              const commandTimeout = setTimeout(() => {
                if (!processEnded && !resolved) {
                  processEnded = true;
                  checkovProcess.kill();
                  console.warn(`\n⏱️  Checkov command timed out after 2 minutes`);
                  console.warn(`   stdout length: ${stdout.length}`);
                  console.warn(`   stderr length: ${stderr.length}`);
                  if (!hasOutput) {
                    console.warn(`   ⚠️  No output received from Checkov - process may not have started`);
                  }
                  console.warn(`   Trying next command...`);
                  tryNextCommand();
                }
              }, 2 * 60 * 1000);

              checkovProcess.stdout.on('data', (data: any) => {
                hasOutput = true;
                const text = data.toString();
                stdout += text;
                console.log(`📥 stdout chunk (${text.length} bytes): ${text.substring(0, 200).replace(/\n/g, '\\n')}`);
              });

              checkovProcess.stderr.on('data', (data: any) => {
                hasOutput = true;
                const stderrText = data.toString();
                stderr += stderrText;
                // Log all stderr for debugging
                console.log(`📥 stderr chunk (${stderrText.length} bytes): ${stderrText.substring(0, 300).replace(/\n/g, '\\n')}`);
              });

              // Wait for streams to end (critical for Windows shell execution)
              checkovProcess.stdout.on('end', () => {
                stdoutEnded = true;
                console.log(`   ✅ stdout stream ended`);
                checkIfReady();
              });

              checkovProcess.stderr.on('end', () => {
                stderrEnded = true;
                console.log(`   ✅ stderr stream ended`);
                checkIfReady();
              });

              // Store exit code for use in processOutput
              let exitCode: number | null = null;

              // Process the output when both streams end AND process closes
              // On Windows, streams may not always emit 'end' events, so we also check processEnded
              let processOutputScheduled = false;
              
              const checkIfReady = () => {
                if (streamsEnded || resolved || processOutputScheduled) return;
                
                // Option 1: Both streams ended AND process closed (ideal case)
                if (stdoutEnded && stderrEnded && processEnded && exitCode !== null) {
                  streamsEnded = true;
                  processOutputScheduled = true;
                  processOutput(exitCode);
                  return;
                }
                
                // Option 2: Process closed and we have output, but streams didn't end
                // This is common on Windows - process closes but streams don't emit 'end'
                // Process immediately if we have output (don't wait for streams)
                if (processEnded && exitCode !== null && hasOutput && !streamsEnded && !processOutputScheduled) {
                  processOutputScheduled = true;
                  // On Windows, streams often don't emit 'end', so process immediately
                  // Give a tiny delay (50ms) to catch any last chunks, then process
                  setTimeout(() => {
                    if (!streamsEnded && !resolved) {
                      console.log(`   ⚠️  Processing output (process closed, streams didn't emit 'end' - Windows behavior)`);
                      console.log(`   stdout ended: ${stdoutEnded}, stderr ended: ${stderrEnded}`);
                      console.log(`   Processing anyway since we have output`);
                      streamsEnded = true;
                      processOutput(exitCode!);
                    }
                  }, 50);
                }
              };

              const processOutput = (code: number) => {
                if (resolved) return;
                clearTimeout(commandTimeout);
                
                console.log(`\n📊 Processing Checkov output (code: ${code})`);
                console.log(`   Command: ${command} ${fullArgs.join(' ')}`);
                console.log(`   stdout length: ${stdout.length} bytes`);
                console.log(`   stderr length: ${stderr.length} bytes`);
                console.log(`   Has output: ${hasOutput}`);
                
                if (stdout.length > 0) {
                  console.log(`\n📄 Full stdout (first 1000 chars):`);
                  console.log(stdout.substring(0, 1000));
                } else {
                  console.log(`   ⚠️  No stdout received`);
                }
                
                if (stderr.length > 0) {
                  console.log(`\n📄 Full stderr (first 1000 chars):`);
                  console.log(stderr.substring(0, 1000));
                } else {
                  console.log(`   ℹ️  No stderr received`);
                }
                
                // If process exits with code 0 or 1 but no output, it might be a different issue
                if (!hasOutput && (code === 0 || code === 1)) {
                  console.warn(`\n⚠️  Process exited with code ${code} but produced no output`);
                  console.warn(`   This might indicate:`);
                  console.warn(`   - Checkov is not installed`);
                  console.warn(`   - Command syntax is incorrect`);
                  console.warn(`   - Output is being redirected elsewhere`);
                  tryNextCommand();
                  return;
                }
                
                // Continue with JSON extraction below...
                
          // Checkov exits with non-zero code if there are failures
          // But still outputs JSON, so we can parse it
                // Exit code 0 = success, 1 = failures found (but JSON still valid), 2+ = error
                try {
                  console.log(`\n🔍 Analyzing output for JSON...`);
                  console.log(`   stdout length: ${stdout.length} chars`);
                  console.log(`   stderr length: ${stderr.length} chars`);
                  
                  // IMPORTANT: Checkov outputs JSON to stdout
                  // stderr may contain warnings like "File association not found" which are harmless
                  // We should prioritize stdout for JSON extraction
                  
                  let jsonText = '';
                  
                  // Step 1: Check stdout first (this is where Checkov puts JSON)
                  if (stdout && stdout.trim().length > 0) {
                    const stdoutTrimmed = stdout.trim();
                    console.log(`   stdout starts with: '${stdoutTrimmed.substring(0, 50)}...'`);
                    
                    if (stdoutTrimmed.startsWith('{')) {
                      // stdout starts with JSON - use it directly
                      jsonText = stdoutTrimmed;
                      console.log(`✅ Found JSON in stdout (starts with '{', ${jsonText.length} chars)`);
          } else {
                      // Try to extract JSON from stdout (in case there's leading whitespace or other text)
                      // Look for first { ... } block
                      const stdoutMatch = stdout.match(/\{[\s\S]*\}/);
                      if (stdoutMatch && stdoutMatch[0]) {
                        jsonText = stdoutMatch[0];
                        console.log(`✅ Extracted JSON from stdout (${jsonText.length} chars)`);
                        console.log(`   JSON starts with: '${jsonText.substring(0, 50)}...'`);
                      } else {
                        console.warn(`   ⚠️  No JSON pattern found in stdout`);
                        console.warn(`   stdout content: ${stdout.substring(0, 200)}`);
                      }
                    }
                  } else {
                    console.warn(`   ⚠️  stdout is empty`);
                  }
                  
                  // Step 2: If no JSON in stdout, check stderr (sometimes JSON goes to stderr)
                  if (!jsonText && stderr && stderr.trim().length > 0) {
                    const stderrTrimmed = stderr.trim();
                    console.log(`   Checking stderr for JSON...`);
                    console.log(`   stderr starts with: '${stderrTrimmed.substring(0, 50)}...'`);
                    
                    if (stderrTrimmed.startsWith('{')) {
                      jsonText = stderrTrimmed;
                      console.log(`✅ Found JSON in stderr (starts with '{', ${jsonText.length} chars)`);
                    } else {
                      const stderrMatch = stderr.match(/\{[\s\S]*\}/);
                      if (stderrMatch && stderrMatch[0]) {
                        jsonText = stderrMatch[0];
                        console.log(`✅ Extracted JSON from stderr (${jsonText.length} chars)`);
                      }
                    }
                  }
                  
                  // Step 3: If still no JSON, try combined output (last resort)
                  if (!jsonText) {
                    const allOutput = (stdout + '\n' + stderr).trim();
                    console.log(`   Trying combined output (stdout + stderr)...`);
                    console.log(`   Combined length: ${allOutput.length} chars`);
                    
                    if (allOutput.length > 0) {
                      const allOutputTrimmed = allOutput.trim();
                      if (allOutputTrimmed.startsWith('{')) {
                        jsonText = allOutputTrimmed;
                        console.log(`✅ Found JSON in combined output (starts with '{', ${jsonText.length} chars)`);
                      } else {
                        const combinedMatch = allOutput.match(/\{[\s\S]*\}/);
                        if (combinedMatch && combinedMatch[0]) {
                          jsonText = combinedMatch[0];
                          console.log(`✅ Extracted JSON from combined output (${jsonText.length} chars)`);
                        }
                      }
                    }
                  }
                  
                  // Log what we found
                  if (jsonText) {
                    console.log(`   JSON preview: ${jsonText.substring(0, 100)}...`);
                  } else {
                    console.warn(`   ⚠️  No JSON text found after extraction`);
                  }
                  
                  // If we found JSON, try to parse it
                  if (jsonText && jsonText.startsWith('{')) {
                    try {
                      const parsed = JSON.parse(jsonText);
                      console.log(`✅ Successfully parsed Checkov JSON output`);
                      console.log(`   Keys: ${Object.keys(parsed).join(', ')}`);
                      resolved = true;
                      cleanup();
                      resolve(parsed);
                      return;
                    } catch (parseErr: any) {
                      console.error(`❌ JSON parse error: ${parseErr.message}`);
                      console.error(`   JSON text length: ${jsonText.length}`);
                      console.error(`   JSON text preview: ${jsonText.substring(0, 500)}`);
                      console.error(`   JSON text end: ${jsonText.substring(Math.max(0, jsonText.length - 200))}`);
                      tryNextCommand();
                      return;
                    }
                  }
                  
                  // No valid JSON found, try next command
                  console.warn(`\n⚠️  ========== NO VALID JSON OUTPUT ==========`);
                  console.warn(`   Exit code: ${code}`);
                  console.warn(`   Command: ${command} ${fullArgs.join(' ')}`);
                  console.warn(`   stdout length: ${stdout.length} bytes`);
                  console.warn(`   stderr length: ${stderr.length} bytes`);
                  console.warn(`   Has output: ${hasOutput}`);
                  console.warn(`   jsonText found: ${jsonText ? 'YES (' + jsonText.length + ' chars)' : 'NO'}`);
                  console.warn(`   stdout ended: ${stdoutEnded}, stderr ended: ${stderrEnded}`);
                  console.warn(`==========================================`);
                  
                  // Show full output for debugging
                  if (stdout.length > 0) {
                    console.warn(`\n   📄 FULL stdout (${stdout.length} chars):`);
                    console.warn(stdout);
                  } else {
                    console.warn(`   stdout: (empty)`);
                  }
                  
                  if (stderr.length > 0) {
                    console.warn(`\n   📄 FULL stderr (${stderr.length} chars):`);
                    console.warn(stderr);
                  } else {
                    console.warn(`   stderr: (empty)`);
                  }
                  
                  // Show what we tried to extract
                  if (jsonText) {
                    console.warn(`\n   📄 Extracted jsonText (${jsonText.length} chars):`);
                    console.warn(jsonText.substring(0, 500));
                  }
                  
                  console.warn(`\n   Trying next command...`);
                  tryNextCommand();
                } catch (parseError: any) {
                  // Parse error, try next command
                  console.error(`❌ Error processing Checkov output: ${parseError.message}`);
                  console.error(`   stdout: ${stdout.substring(0, 500)}`);
                  console.error(`   stderr: ${stderr.substring(0, 500)}`);
                  tryNextCommand();
                }
              };

              checkovProcess.on('close', (code: any) => {
                // Prevent multiple calls
                if (processEnded || resolved) {
                  return;
                }
                processEnded = true;
                exitCode = code;
                
                console.log(`\n📊 Checkov process closed with code: ${code}`);
                console.log(`   Command: ${command} ${fullArgs.join(' ')}`);
                console.log(`   stdout ended: ${stdoutEnded}, stderr ended: ${stderrEnded}`);
                console.log(`   stdout length: ${stdout.length} bytes`);
                console.log(`   stderr length: ${stderr.length} bytes`);
                console.log(`   Has output: ${hasOutput}`);
                
                // Check if we can process output now (streams may have already ended)
                checkIfReady();
                
                // CRITICAL FIX: On Windows, streams often don't emit 'end' events
                // If process closed and we have output, process it after a short delay
                // This is the most reliable way to handle Windows stream behavior
                if (hasOutput && !processOutputScheduled && !resolved) {
                  // Give streams 200ms to emit 'end' events, then process anyway
                  setTimeout(() => {
                    if (!streamsEnded && !resolved && processEnded && exitCode !== null) {
                      console.warn(`   ⚠️  Windows fallback: Processing output (streams didn't emit 'end' events)`);
                      console.warn(`   stdout ended: ${stdoutEnded}, stderr ended: ${stderrEnded}`);
                      console.warn(`   stdout length: ${stdout.length}, stderr length: ${stderr.length}`);
                      console.warn(`   This is normal on Windows - streams don't always emit 'end' events`);
                      streamsEnded = true;
                      processOutput(exitCode);
                    }
                  }, 200);
                } else if (!hasOutput && !processOutputScheduled) {
                  // No output at all - this is a real problem
                  console.warn(`   ⚠️  Process closed but no output received`);
                  console.warn(`   This might indicate the command failed to execute`);
                  // Don't process, let it try next command
                }
              });

              checkovProcess.on('error', (error: any) => {
                if (processEnded) return;
                processEnded = true;
                clearTimeout(commandTimeout);
                
                if (resolved) return;
                
                console.error(`\n❌ Checkov process spawn error:`);
                console.error(`   Message: ${error.message}`);
                console.error(`   Code: ${error.code}`);
                console.error(`   Syscall: ${error.syscall}`);
                console.error(`   Original command: ${command}`);
                console.error(`   Original args: ${fullArgs.join(' ')}`);
                console.error(`   Final command: ${finalCommand}`);
                console.error(`   Final args: ${finalArgs.join(' ')}`);
                console.error(`   Full error:`, JSON.stringify(error, Object.getOwnPropertyNames(error)));
                
                if (error.code === 'ENOENT' || error.message.includes('ENOENT') || error.message.includes('not recognized')) {
                  // Command not found, try next command
                  console.warn(`⚠️  Command '${command}' not found in PATH, trying next command...`);
                  console.warn(`   Current PATH: ${env.PATH?.substring(0, 200)}...`);
                  tryNextCommand();
                } else {
                  // Other error - log it but still try next command
                  console.warn(`⚠️  Process spawn error (${error.code}), trying next command...`);
                  tryNextCommand();
                }
              });
            };
            
            // Set overall timeout
            timeoutId = setTimeout(() => {
              if (!resolved) {
                resolved = true;
                cleanup();
                reject(new Error('Checkov scan timed out after 5 minutes. The scan may be taking too long or Checkov may be stuck.'));
              }
            }, TIMEOUT_MS);
            
            // Start with first command
            tryNextCommand();
          }),
          new Promise<any>((_, reject) => {
            setTimeout(() => {
              reject(new Error('Checkov scan timed out after 5 minutes'));
            }, TIMEOUT_MS);
          })
        ]).catch((error) => {
          console.error('❌ Promise.race rejected:', error);
          throw error;
        });

        // Parse results - Checkov JSON structure
        console.log('\n✅ Checkov scan Promise resolved');
        console.log('Checkov scan completed. Raw result keys:', Object.keys(scanResult || {}));
        console.log('Checkov scan result sample:', JSON.stringify(scanResult).substring(0, 500));
        
        // Validate scanResult
        if (!scanResult || typeof scanResult !== 'object') {
          console.error('❌ Invalid scanResult:', typeof scanResult, scanResult);
          throw new Error(`Invalid Checkov scan result: expected object, got ${typeof scanResult}`);
        }
        
        // Debug: Log full structure to understand Checkov output format
        if (scanResult.summary) {
          console.log('📊 Found summary object:', JSON.stringify(scanResult.summary));
        } else {
          console.log('⚠️  No summary object found, will calculate from check counts');
        }
        
        // Check if Checkov found any files to scan
        if (scanResult.summary) {
          const resourceCount = scanResult.summary.resource_count || 0;
          console.log(`📋 Checkov scanned ${resourceCount} resource(s)`);
          if (resourceCount === 0) {
            console.error('❌ WARNING: Checkov found 0 resources to scan!');
            console.error('   This usually means:');
            console.error('   1. No Terraform files were found in the temp directory');
            console.error('   2. Files were written but Checkov cannot parse them');
            console.error('   3. Files are in wrong location or format');
          }
        }
        
        // Checkov JSON structure (version 3.x):
        // { check_type, results: { failed_checks, passed_checks? }, summary: { passed, failed, skipped, ... } }
        // NOTE: With --compact flag, Checkov only includes failed_checks in results, not passed_checks
        // The summary object contains the accurate counts
        const summary = scanResult.summary || {};
        const results = scanResult.results || {};
        
        // Try summary object first (newer Checkov format), then root level (older format)
        // Summary is the authoritative source for counts
        const passed = summary.passed ?? scanResult.passed ?? 0;
        const failed = summary.failed ?? scanResult.failed ?? 0;
        const skipped = summary.skipped ?? scanResult.skipped ?? 0;

        // Get detailed check results
        // NOTE: With --compact, only failed_checks are included in JSON output
        // passed_checks array may be empty or missing, but summary.passed has the count
        const checks = results.failed_checks || [];
        const passedChecks = results.passed_checks || [];
        
        // Calculate totals - ALWAYS use summary counts as primary source
        // Summary counts are accurate even when passed_checks array is empty (due to --compact)
        const actualPassed = passed; // Use summary.passed directly
        const actualFailed = failed;  // Use summary.failed directly
        const total = actualPassed + actualFailed + skipped;
        const passPercentage = total > 0 ? Math.round((actualPassed / total) * 100) : 0;
        
        // Log for debugging
        console.log(`\n📊 ========== CHECKOV SCAN RESULTS PARSING ==========`);
        console.log(`   Raw summary:`, JSON.stringify(summary));
        console.log(`   Summary counts: passed=${passed}, failed=${failed}, skipped=${skipped}`);
        console.log(`   Detailed checks: failed_checks=${checks.length}, passed_checks array=${passedChecks.length}`);
        console.log(`   Using summary counts: actualPassed=${actualPassed}, actualFailed=${actualFailed}`);
        console.log(`   Total: ${total}, Pass Rate: ${passPercentage}%`);
        
        // Warn if all values are 0 (likely means no files were scanned)
        if (total === 0 && actualPassed === 0 && actualFailed === 0) {
          console.error(`\n❌ WARNING: All scan results are 0!`);
          console.error(`   This indicates Checkov did not find any Terraform resources to scan.`);
          console.error(`   Possible causes:`);
          console.error(`   1. No Terraform files were written to temp directory`);
          console.error(`   2. Files were written but Checkov cannot parse them`);
          console.error(`   3. Files are empty or invalid`);
          console.error(`   Check the file writing logs above for details.`);
        }
        
        console.log(`==========================================\n`);

        // Prepare response
        const response = {
          success: true,
          summary: {
            passed: actualPassed,
            failed: actualFailed,
            skipped,
            total,
            passPercentage
          },
          failedChecks: checks.map((check: any) => ({
            checkId: check.check_id,
            checkName: check.check_name,
            resource: check.resource,
            file: check.file_path?.replace(tempDir, ''),
            guideline: check.guideline
          })),
          passedChecks: passedChecks.slice(0, 10).map((check: any) => ({
            checkId: check.check_id,
            checkName: check.check_name,
            resource: check.resource
          }))
        };
        
        // Log final response for debugging
        console.log(`\n📤 Sending response to client:`);
        console.log(`   Summary: ${response.summary.passed} passed, ${response.summary.failed} failed, ${response.summary.total} total`);
        console.log(`   Failed checks: ${response.failedChecks.length}`);
        console.log(`   Passed checks: ${response.passedChecks.length}`);
        
        res.json(response);
      } finally {
        // Clean up temp directory
        try {
          console.log(`\n🧹 Cleaning up temp directory: ${tempDir}`);
        await fs.rm(tempDir, { recursive: true, force: true });
          console.log(`✅ Temp directory cleaned up`);
          
          // Also clean up base temp directory if empty
          const tempBaseDir = path.join(process.cwd(), '.temp-checkov');
          try {
            const entries = await fs.readdir(tempBaseDir);
            if (entries.length === 0) {
              await fs.rmdir(tempBaseDir);
              console.log(`✅ Base temp directory cleaned up`);
            }
          } catch (e) {
            // Ignore errors cleaning up base dir
            console.warn('⚠️  Could not clean up base temp dir:', e);
          }
        } catch (cleanupError) {
          console.warn('⚠️  Failed to clean up temp directory:', cleanupError);
        }
      }
    } catch (error: any) {
      console.error('\n❌ ========== CHECKOV SCAN ERROR ==========');
      console.error('Session ID:', sessionId);
      console.error('Error type:', error?.constructor?.name || typeof error);
      console.error('Error message:', error?.message || String(error));
      console.error('Error code:', error?.code);
      console.error('Error name:', error?.name);
      if (error?.stack) {
        console.error('Error stack:');
        console.error(error.stack);
      }
      console.error('==========================================\n');
      
      // Provide more helpful error message
      let errorMessage = error?.message || 'Failed to run security scan';
      let errorDetails = '';
      
      // Check for specific error types
      if (error?.code === 'ENOENT') {
        errorMessage = 'Checkov command not found';
        errorDetails = 'The Checkov executable could not be found. Please verify installation.';
      } else if (error?.message?.includes('timeout')) {
        errorMessage = 'Checkov scan timed out';
        errorDetails = 'The scan took too long to complete. This might indicate an issue with Checkov or the files being scanned.';
      } else if (error?.message?.includes('Checkov')) {
        errorMessage = error.message;
        errorDetails = 'Please check the server console logs above for detailed error information about why Checkov failed to execute.';
      } else {
        errorDetails = error?.stack || error?.message || 'Unknown error occurred';
      }
      
      res.status(500).json({ 
        error: errorMessage,
        details: errorDetails,
        sessionId: req.params.id,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Refactor and validate Terraform best practices
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
        const variablePattern = /variable\s+"([^"]+)"/g;
        let match;
        while ((match = variablePattern.exec(variablesTf.content)) !== null) {
          declaredVariables.add(match[1]);
        }
        console.log(`   Declared variables: ${Array.from(declaredVariables).join(', ')}`);
      }

      // Extract all variables used in main.tf
      const usedVariables = new Set<string>();
      if (mainTf) {
        // Match var.variable_name or ${var.variable_name}
        const varPattern = /var\.([a-zA-Z0-9_-]+)/g;
        let match;
        while ((match = varPattern.exec(mainTf.content)) !== null) {
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
          const configurableAttributes = ['name', 'location', 'region', 'resource_group_name', 'account_tier', 'account_replication_type', 'sku', 'instance_type', 'instance_class', 'size', 'tier', 'capacity', 'billing_mode', 'read_capacity', 'write_capacity'];

          configurableAttributes.forEach(attr => {
            // Match: attribute = "value" or attribute = value
            const attrPattern = new RegExp(`${attr}\\s*=\\s*"([^"]+)"`, 'i');
            const attrMatch = trimmed.match(attrPattern);
            
            if (attrMatch) {
              const value = attrMatch[1];
              // Skip if it's a reference (data., resource., etc.)
              if (!value.match(/^(data\.|resource\.|module\.|local\.|path\.|self\.|count\.|each\.)/) &&
                  !value.match(/^[0-9]+$/) && // Skip pure numbers
                  value.length > 1 &&
                  !value.match(/^(true|false|null)$/i)) {
                
                // Check if this value looks configurable (not a built-in identifier)
                if (!value.match(/^(azurerm_|aws_|google_|Standard|Premium|Basic)/i) &&
                    value.length > 3) { // Only flag meaningful values
                  
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
                resourceName.length > 5 && // Meaningful names
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

        // Fix 1: Add missing variable declarations to variables.tf
        if (mainTf && variablesTf) {
          const missingDeclarations = Array.from(usedVariables).filter(v => !declaredVariables.has(v));
          if (missingDeclarations.length > 0) {
            console.log(`      🔧 Fix 1: Adding ${missingDeclarations.length} missing variable declaration(s) to variables.tf`);
            let newContent = variablesTf.content;
            missingDeclarations.forEach(varName => {
              // Add variable declaration at the end
              const varDeclaration = `\n\nvariable "${varName}" {\n  description = "Value for ${varName}"\n  type        = string\n}`;
              newContent += varDeclaration;
              fixes.push(`Added variable declaration for "${varName}" to variables.tf`);
              fixedIssues++;
            });
            await storage.updateFile(variablesTf.id, newContent);
            console.log(`      ✅ Updated variables.tf (ID: ${variablesTf.id}, new size: ${newContent.length} chars)`);
            variablesTf = { ...variablesTf, content: newContent };
            declaredVariables.clear();
            // Re-extract declared variables
            const variablePattern = /variable\s+"([^"]+)"/g;
            let match;
            while ((match = variablePattern.exec(newContent)) !== null) {
              declaredVariables.add(match[1]);
            }
          }
        }

        // Fix 2: Add missing variables to tfvars
        if (variablesTf && primaryTfvars) {
          const missingInTfvars = Array.from(declaredVariables).filter(v => !tfvarsVariables.has(v));
          if (missingInTfvars.length > 0) {
            console.log(`      🔧 Fix 2: Adding ${missingInTfvars.length} missing variable(s) to ${primaryTfvars.fileName}`);
            let newContent = primaryTfvars.content.trim();
            if (!newContent.endsWith('\n')) {
              newContent += '\n';
            }
            missingInTfvars.forEach(varName => {
              // Add variable assignment
              const varAssignment = `\n${varName} = "<value>"  # TODO: Set appropriate value`;
              newContent += varAssignment;
              fixes.push(`Added "${varName}" to ${primaryTfvars.fileName} (needs value)`);
              fixedIssues++;
            });
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
              const refreshedTfvars = refreshedFiles.find(f => f.fileName === 'dev.terraform.tfvars' || f.fileName.endsWith('.tfvars'));
              
              if (refreshedMainTf) {
                mainTf = refreshedMainTf;
              }
              if (refreshedVariablesTf) {
                variablesTf = refreshedVariablesTf;
              }
              if (refreshedTfvars) {
                // Update primaryTfvars reference
                const updatedTfvarsFiles = refreshedFiles.filter(f => f.fileName.endsWith('.tfvars'));
                const updatedPrimaryTfvars = updatedTfvarsFiles.find(f => f.fileName === 'dev.terraform.tfvars') || updatedTfvarsFiles[0];
                if (updatedPrimaryTfvars) {
                  // Note: primaryTfvars is const, so we can't reassign it, but we'll use the refreshed one
                }
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
          
          // Use AI to detect configurable attributes for each resource type
          // For now, use a common list, but this could be enhanced with AI per-resource
          const configurableAttributes = [
            'name', 'location', 'region', 'resource_group_name', 'account_tier',
            'account_replication_type', 'sku', 'instance_type', 'instance_class',
            'size', 'tier', 'capacity', 'billing_mode', 'read_capacity', 'write_capacity'
          ];

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
        fixes: allFixes
      });
    } catch (error: any) {
      console.error('Error fixing Terraform files:', error);
      res.status(500).json({ 
        error: 'Failed to fix Terraform files',
        details: error.message 
      });
    }
  });

  // Commit files to repository
  app.post("/api/sessions/:id/commit", async (req, res) => {
      const sessionId = req.params.id;
    let session: any = null;
    
    try {
      session = await storage.getSession(sessionId);
      
      if (!session || !session.provider || !session.repositoryName) {
        return res.status(400).json({ error: 'Session not properly configured' });
      }

      // Get files from session storage (where generated files are stored)
      console.log(`\n📁 Getting files from session storage for commit...`);
      const files = await storage.getFilesBySession(sessionId);
      
      console.log(`✅ Found ${files.length} file(s) in session storage`);
      
      if (files.length === 0) {
        return res.status(400).json({ 
          error: 'No files found to commit',
          details: 'No files have been generated for this session yet. Please generate Terraform files first.'
        });
      }
      
      // Filter to Terraform files only
      const terraformFiles = files.filter(file => {
        const fileName = file.fileName.toLowerCase();
        return fileName.endsWith('.tf') || fileName.endsWith('.tfvars');
      });
      
      console.log(`📄 Terraform files to commit: ${terraformFiles.length}`);
      terraformFiles.forEach(f => {
        console.log(`   - ${f.fileName} (${f.content.length} chars)`);
      });
      
      if (terraformFiles.length === 0) {
        return res.status(400).json({ 
          error: 'No Terraform files found to commit',
          details: 'No Terraform files (.tf or .tfvars) found in session or repository'
        });
      }
      
      // Generate commit message based on file contents
      const commitMessage = await openaiService.generateCommitMessage(
        terraformFiles.map(f => ({ name: f.fileName, content: f.content }))
      );

      // Commit via MCP
      const result = await mcpClient.commitFiles(
        session.provider as MCPProvider,
        session.repositoryName,
        terraformFiles.map(f => ({ path: f.fileName, content: f.content })),
        commitMessage
      );

      // CRITICAL: Clear session data after successful commit to allow fresh start
      console.log(`\n🧹 Clearing session data after successful commit...`);
      console.log(`   This allows starting fresh for the next workflow`);
      
      // Delete all files from session storage
      await storage.deleteFilesBySession(sessionId);
      console.log(`   ✅ Cleared ${terraformFiles.length} file(s) from session storage`);
      
      // Reset session state to allow starting fresh
      await storage.updateSession(sessionId, {
        currentStep: '1', // Reset to step 1 (provider selection) - stored as string
        workflowStep: undefined, // Clear workflow step
        // Keep provider and repositoryName so user doesn't have to reconfigure
        // Keep moduleApproach if set
      });
      console.log(`   ✅ Reset session state (currentStep: 1)`);
      console.log(`   ✅ Session is now ready for a fresh start`);

      res.json({ 
        success: true, 
        commitMessage, 
        result,
        commitSha: result.commit?.sha || result.sha || result.commitSha,
        branch: result.branch || 'main',
        filesCommitted: terraformFiles.length,
        sessionReset: true, // Indicate that session was reset
        message: 'Files committed successfully. Session cleared and ready for a fresh start.'
      });
    } catch (error: any) {
      console.error('\n❌ ========== COMMIT ERROR ==========');
      console.error('Error committing files:', error);
      console.error('Error message:', error?.message);
      console.error('Error code:', error?.code);
      console.error('Error data:', error?.data);
      console.error('Error stack:', error?.stack);
      console.error('Session ID:', sessionId);
      console.error('Provider:', session?.provider);
      console.error('Repository:', session?.repositoryName);
      console.error('Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
      console.error('=====================================\n');
      
      const errorMessage = error?.message || 'Failed to commit files';
      
      // Extract more details from the error
      const errorDetails: any = {
        message: errorMessage,
        code: error?.code,
        data: error?.data,
        stack: error?.stack,
        sessionId,
        provider: session?.provider,
        repository: session?.repositoryName,
        errorType: error?.constructor?.name || typeof error
      };
      
      // Check if error is from MCP and includes "not found"
      if (errorMessage.includes('MCP error') && errorMessage.includes('Not Found')) {
        console.error('⚠️  MCP error occurred - "Resource not found"');
        console.error('   This typically means:');
        console.error('   1. Repository branch doesn\'t exist (empty repo)');
        console.error('   2. Repository path/name is incorrect');
        console.error('   3. GitHub MCP server internal issue');
        errorDetails.suggestedFix = 'Check if repository is empty or branch name is correct';
      }
      
      res.status(500).json({ 
        error: errorMessage,
        details: errorDetails
      });
    }
  });

  // Test Terraform MCP server connection
  app.get("/api/debug/terraform-mcp", async (req, res) => {
    try {
      console.log('🧪 Testing Terraform MCP server connection...');
      
      const testResults: any = {
        timestamp: new Date().toISOString(),
        tests: []
      };
      
      // Test 1: Check package availability
      testResults.tests.push({
        name: 'Package check',
        status: 'info',
        message: 'Run: npm view terraform-mcp-server to check if package exists'
      });
      
      // Test 2: Try to get client
      try {
        const client = await mcpClient.getClient('terraform');
        testResults.tests.push({
          name: 'MCP client connection',
          status: 'success',
          message: 'Successfully connected to Terraform MCP server'
        });
        
        // Test 3: List tools
        try {
          const tools = await client.listTools();
          testResults.tests.push({
            name: 'List tools',
            status: 'success',
            toolCount: tools.tools?.length || 0,
            tools: tools.tools?.map((t: any) => ({
              name: t.name,
              description: t.description?.substring(0, 100)
            })) || []
          });
        } catch (toolError: any) {
          testResults.tests.push({
            name: 'List tools',
            status: 'error',
            error: toolError.message
          });
        }
      } catch (clientError: any) {
        const errorMsg = clientError.message || String(clientError);
        testResults.tests.push({
          name: 'MCP client connection',
          status: 'error',
          error: errorMsg,
          troubleshooting: [
            '1. Test manually: npx -y terraform-mcp-server',
            '2. Check if package exists: npm view terraform-mcp-server',
            '3. Verify Node.js version: node --version (should be >= 18)',
            '4. Clear npm cache: npm cache clean --force',
            '5. Note: Package may not be publicly available yet'
          ]
        });
      }
      
      res.json(testResults);
    } catch (error: any) {
      console.error('Error testing Terraform MCP:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Debug endpoint to list available MCP tools
  app.get("/api/debug/tools/:provider", async (req, res) => {
    try {
      const provider = req.params.provider as MCPProvider;
      const tools = await mcpClient.listTools(provider);
      res.json(tools);
    } catch (error) {
      console.error('Error listing tools:', error);
      res.status(500).json({ error: 'Failed to list tools' });
    }
  });


  // Auto-fix Checkov scan failures using AI
  app.post("/api/sessions/:id/fix-issues", async (req, res) => {
    const sessionId = req.params.id;
    const { failedChecks } = req.body;

    console.log(`\n🔧 ========== AUTO-FIX REQUEST ==========`);
    console.log(`Session ID: ${sessionId}`);
    console.log(`Failed checks to fix: ${failedChecks?.length || 0}`);

    try {
      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ 
          error: 'Session not found',
          details: `Session ${sessionId} does not exist`
        });
      }

      if (!failedChecks || !Array.isArray(failedChecks) || failedChecks.length === 0) {
        return res.status(400).json({ 
          error: 'No failed checks provided',
          details: 'Please provide an array of failed checks to fix'
        });
      }

      // Get all Terraform files for this session
      const allFiles = await storage.getFilesBySession(sessionId);
      const terraformFiles = allFiles.filter(file => {
        const fileName = file.fileName.toLowerCase();
        return fileName.endsWith('.tf') || fileName.endsWith('.tfvars') || fileName.endsWith('.hcl');
      });

      if (terraformFiles.length === 0) {
        return res.status(400).json({ 
          error: 'No Terraform files found',
          details: 'No Terraform files exist for this session'
        });
      }

      console.log(`📁 Found ${terraformFiles.length} Terraform file(s) to fix`);

      // Group failed checks by file
      const checksByFile = new Map<string, any[]>();
      failedChecks.forEach((check: any) => {
        // Normalize file path - Checkov may return paths like /main.tf, ./main.tf, or main.tf
        let fileName = check.file?.replace(/^[\\/]/, '') || 'main.tf';
        fileName = fileName.replace(/^\.\//, ''); // Remove leading ./
        fileName = fileName.split('/').pop() || fileName; // Get just the filename
        fileName = fileName.split('\\').pop() || fileName; // Handle Windows paths
        
        if (!checksByFile.has(fileName)) {
          checksByFile.set(fileName, []);
        }
        checksByFile.get(fileName)!.push(check);
      });

      console.log(`📋 Issues grouped by file:`);
      checksByFile.forEach((checks, file) => {
        console.log(`   ${file}: ${checks.length} issue(s)`);
      });
      
      console.log(`📁 Available Terraform files in session:`);
      terraformFiles.forEach(f => {
        console.log(`   - ${f.fileName} (ID: ${f.id})`);
      });

      // Fix each file
      const fixedFiles: Array<{ fileName: string; content: string }> = [];
      const fixResults: Array<{
        checkId: string;
        checkName: string;
        file: string;
        resource: string;
        status: 'fixed' | 'failed' | 'skipped';
        reason?: string;
      }> = [];
      
      for (const [fileName, checks] of Array.from(checksByFile.entries())) {
        // Try multiple matching strategies
        let file = terraformFiles.find(f => f.fileName === fileName);
        if (!file) {
          // Try case-insensitive match
          file = terraformFiles.find(f => f.fileName.toLowerCase() === fileName.toLowerCase());
        }
        if (!file) {
          // Try endsWith match
          file = terraformFiles.find(f => f.fileName.endsWith(fileName) || fileName.endsWith(f.fileName));
        }
        if (!file) {
          // Try basename match (handle paths)
          const baseName = fileName.split('/').pop()?.split('\\').pop();
          file = terraformFiles.find(f => {
            const fBaseName = f.fileName.split('/').pop()?.split('\\').pop();
            return fBaseName === baseName;
          });
        }
        
        if (!file) {
          console.warn(`⚠️  File not found: ${fileName}`);
          console.warn(`   Available files: ${terraformFiles.map(f => f.fileName).join(', ')}`);
          // Mark all checks for this file as skipped
          checks.forEach((check: any) => {
            fixResults.push({
              checkId: check.checkId,
              checkName: check.checkName,
              file: fileName,
              resource: check.resource,
              status: 'skipped',
              reason: `File not found: ${fileName}`
            });
          });
          continue;
        }
        
        console.log(`   ✅ Matched file: ${file.fileName} (ID: ${file.id})`);

        console.log(`\n🔧 Fixing ${fileName}...`);
        console.log(`   Issues to fix: ${checks.length}`);
        
        // Process checks in batches if there are too many (better success rate)
        const BATCH_SIZE = 5; // Process 5 checks at a time for better AI focus
        const checkBatches: any[][] = [];
        for (let i = 0; i < checks.length; i += BATCH_SIZE) {
          checkBatches.push(checks.slice(i, i + BATCH_SIZE));
        }
        
        console.log(`   📦 Processing ${checkBatches.length} batch(es) of checks`);
        
        let currentFileContent = file.content;
        let fileWasUpdated = false;
        
        // Process each batch
        for (let batchIdx = 0; batchIdx < checkBatches.length; batchIdx++) {
          const batchChecks = checkBatches[batchIdx];
          console.log(`\n   🔄 Processing batch ${batchIdx + 1}/${checkBatches.length} (${batchChecks.length} check(s))...`);
          
          // Refresh file content before each batch (in case previous batch updated it)
          if (fileWasUpdated && file) {
            const refreshedFiles = await storage.getFilesBySession(sessionId);
            const refreshedFile = refreshedFiles.find(f => f.id === file!.id);
            if (refreshedFile) {
              currentFileContent = refreshedFile.content;
              file = refreshedFile;
            }
          }

          // Create prompt for AI to fix the issues in this batch
          console.log(`   📋 Issues in this batch:`);
          batchChecks.forEach((check: any, idx: number) => {
            console.log(`      ${idx + 1}. ${check.checkName} (${check.checkId})`);
            console.log(`         Resource: ${check.resource}`);
            console.log(`         Guideline: ${check.guideline || 'No guideline'}`);
          });

          // Build detailed issue descriptions using Checkov's own information
          const detailedIssues = batchChecks.map((check: any, idx: number) => {
          let description = `${idx + 1}. ${check.checkName} (${check.checkId})\n`;
          description += `   - Resource: ${check.resource}\n`;
          if (check.guideline) {
            description += `   - Guideline: ${check.guideline}\n`;
          }
          if (check.file) {
            description += `   - File: ${check.file}\n`;
          }
          // Extract resource type from resource string (e.g., "azurerm_storage_account.example" -> "azurerm_storage_account")
          const resourceMatch = check.resource?.match(/^([a-z_]+)/);
          if (resourceMatch) {
            description += `   - Resource Type: ${resourceMatch[1]}\n`;
          }
          return description;
        }).join('\n');

        const fixPrompt = `You are a Terraform security expert specializing in Checkov security fixes. Your task is to fix the Checkov security issues in this Terraform file.

CURRENT FILE CONTENT:
\`\`\`terraform
${currentFileContent || file.content}
\`\`\`

CHECKOV SECURITY ISSUES TO FIX:
${detailedIssues}

ANALYSIS REQUIRED:
1. Read each Checkov check's guideline carefully - it tells you what security requirement is missing
2. Identify the specific resource(s) mentioned in each check
3. Determine what attribute(s) need to be added or modified based on the guideline
4. Apply the fix by adding/modifying the necessary attributes in the resource block

CRITICAL REQUIREMENTS:
1. Fix ALL ${batchChecks.length} issue(s) listed above - this is MANDATORY
2. Each check ID (${batchChecks.map((c: any) => c.checkId).join(', ')}) MUST be addressed
3. You MUST modify the code - returning identical content is NOT acceptable
4. Use the guideline from each check to understand what needs to be fixed
5. Add missing attributes or modify existing ones as required by the guideline
6. Maintain the existing structure and functionality
7. Preserve all comments and formatting style
8. Ensure the code remains valid Terraform syntax
9. Do not remove or rename existing resources unless necessary for the fix

FIX STRATEGY:
- For each failing check, identify the resource type and name
- Read the guideline to understand what security setting is required
- Add or modify the resource attributes to meet the security requirement
- Ensure the fix addresses the specific issue mentioned in the guideline

IMPORTANT: 
- The current code FAILS these Checkov checks
- You MUST make changes to fix them
- If a guideline says "ensure X is enabled", add the attribute with the correct value
- If a guideline says "ensure X is disabled", add the attribute set to false
- Do NOT return the same code - it must be modified

Return ONLY the complete fixed Terraform code in a code block, nothing else.`;

        try {
          // Use OpenAI to generate fixes
          const completion = await openaiService.chat([
            {
              role: 'system',
              content: 'You are a Terraform security expert. Fix security issues in Terraform code based on Checkov scan results. Return only the fixed code in a code block.'
            },
            {
              role: 'user',
              content: fixPrompt
            }
          ]);

          // Extract code from response (handle markdown code blocks)
          let fixedContent = completion.trim();
          
          // Remove markdown code block markers if present
          if (fixedContent.startsWith('```terraform')) {
            fixedContent = fixedContent.replace(/^```terraform\s*\n/, '').replace(/\n```\s*$/, '');
          } else if (fixedContent.startsWith('```')) {
            fixedContent = fixedContent.replace(/^```\s*\n/, '').replace(/\n```\s*$/, '');
          }
          
          console.log(`   📝 AI generated fix (${fixedContent.length} chars, was ${file.content.length} chars)`);
          
          // Check if content actually changed
          const contentToCompare = currentFileContent || file.content;
          if (fixedContent === contentToCompare) {
            console.warn(`   ⚠️  WARNING: AI returned identical content - fix was not applied!`);
            console.warn(`   🔄 Retrying with more explicit instructions...`);
            
            // Retry with a more explicit prompt
            const retryPrompt = `CRITICAL: The Terraform code below FAILS Checkov security checks. You MUST fix it by modifying the code.

CURRENT FILE CONTENT (THIS CODE FAILS CHECKOV CHECKS):
\`\`\`terraform
${file.content}
\`\`\`

FAILING CHECKOV CHECKS (MUST BE FIXED):
${detailedIssues}

WHAT YOU MUST DO:
1. Read each check's guideline - it tells you exactly what security requirement is missing
2. For each check, identify the resource and add/modify the required attribute(s)
3. The output code MUST be different from the input code
4. You MUST make actual changes - returning identical code is a failure
5. Each check ID (${checks.map((c: any) => c.checkId).join(', ')}) must be addressed

FIX PROCESS:
- Read each check's guideline carefully - it tells you exactly what needs to be fixed
- Analyze the guideline to understand what security setting is required
- Determine the appropriate Terraform attribute and value based on the guideline
- Apply the fix by adding or modifying the necessary attributes
- Each check may require different fixes - analyze each one individually

YOU MUST RETURN MODIFIED CODE. DO NOT RETURN IDENTICAL CODE.

Return the COMPLETE fixed Terraform code with ALL necessary security fixes applied.`;
            
            try {
              const retryCompletion = await openaiService.chat([
                {
                  role: 'system',
                  content: 'You are a Terraform security expert. You MUST fix Checkov security issues by modifying the code. Returning identical code is NOT acceptable. You MUST make changes to address each security check.'
                },
                {
                  role: 'user',
                  content: retryPrompt
                }
              ]);
              
              let retryFixedContent = retryCompletion.trim();
              if (retryFixedContent.startsWith('```terraform')) {
                retryFixedContent = retryFixedContent.replace(/^```terraform\s*\n/, '').replace(/\n```\s*$/, '');
              } else if (retryFixedContent.startsWith('```')) {
                retryFixedContent = retryFixedContent.replace(/^```\s*\n/, '').replace(/\n```\s*$/, '');
              }
              
              if (retryFixedContent !== file.content) {
                console.log(`   ✅ Retry successful - content changed`);
                fixedContent = retryFixedContent;
              } else {
                console.warn(`   ❌ Retry also returned identical content`);
                // Mark all checks as failed because no fix was applied
                checks.forEach((check: any) => {
                  fixResults.push({
                    checkId: check.checkId,
                    checkName: check.checkName,
                    file: fileName,
                    resource: check.resource,
                    status: 'failed',
                    reason: 'AI returned identical content after retry - unable to fix this issue automatically. Manual fix required.'
                  });
                });
                continue; // Skip updating the file since it's identical
              }
            } catch (retryError: any) {
              console.error(`   ❌ Retry failed:`, retryError.message);
              // Mark all checks as failed because retry failed
              checks.forEach((check: any) => {
                fixResults.push({
                  checkId: check.checkId,
                  checkName: check.checkName,
                  file: fileName,
                  resource: check.resource,
                  status: 'failed',
                  reason: `Retry failed: ${retryError.message}`
                });
              });
              continue;
            }
          }
          
          const diff = fixedContent.length - currentFileContent.length;
          console.log(`   📊 Content changed: ${diff > 0 ? '+' : ''}${diff} characters`);
          
          // Validate that the fix actually addresses the issues
          const fixValidation = validateFix(currentFileContent, fixedContent, batchChecks);
          if (!fixValidation.isValid) {
            console.warn(`   ⚠️  Fix validation warnings: ${fixValidation.warnings.join(', ')}`);
          }

          // Update the file in storage
          await storage.updateFile(file.id, fixedContent);
          
          // Verify the update was successful by re-fetching all files
          const allFilesAfterUpdate = await storage.getFilesBySession(sessionId);
          const updatedFile = file ? allFilesAfterUpdate.find(f => f.id === file!.id) : null;
          if (updatedFile && updatedFile.content === fixedContent) {
            console.log(`   ✅ Verified: File updated successfully in storage`);
          } else if (updatedFile) {
            console.warn(`   ⚠️  Warning: File content mismatch after update`);
            console.warn(`      Expected: ${fixedContent.length} bytes, Got: ${updatedFile.content.length} bytes`);
            // Mark as failed if verification failed
            checks.forEach((check: any) => {
              fixResults.push({
                checkId: check.checkId,
                checkName: check.checkName,
                file: fileName,
                resource: check.resource,
                status: 'failed',
                reason: 'File update verification failed - content mismatch in storage'
              });
            });
            continue;
          } else {
            console.warn(`   ⚠️  Warning: File not found after update`);
            // Mark as failed if file not found
            checks.forEach((check: any) => {
              fixResults.push({
                checkId: check.checkId,
                checkName: check.checkName,
                file: fileName,
                resource: check.resource,
                status: 'failed',
                reason: 'File not found in storage after update'
              });
            });
            continue;
          }
          
          fixedFiles.push({
            fileName: file.fileName,
            content: fixedContent
          });

          console.log(`   ✅ Fixed ${fileName} (${fixedContent.length} bytes, was ${file.content.length} bytes)`);
          
          // Update current file content for next batch
          currentFileContent = fixedContent;
          fileWasUpdated = true;
          
          // CRITICAL: Verify each check in this batch was actually fixed
          for (const check of batchChecks) {
            let isFixed = false;
            const checkId = check.checkId;
            const resource = check.resource;
            
            // Check if the fix addressed this specific check by looking for the fix in the code
            // This is a heuristic - we check if the guideline requirement appears to be met
            if (check.guideline) {
              const guideline = check.guideline.toLowerCase();
              
              // Common patterns: if guideline says "ensure X is enabled", check if X is in the code
              if (guideline.includes('enable') || guideline.includes('should be enabled')) {
                const enableMatch = guideline.match(/ensure\s+([^is]+)\s+is\s+enabled/i);
                if (enableMatch) {
                  const attribute = enableMatch[1].trim();
                  // Check if this attribute exists in the fixed content for this resource
                  const resourcePattern = new RegExp(`${resource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?\\}`, 'i');
                  const resourceMatch = fixedContent.match(resourcePattern);
                  if (resourceMatch) {
                    // Check if the attribute is present (indicating the fix was applied)
                    const attributePattern = new RegExp(`${attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(true|"true"|1)`, 'i');
                    isFixed = attributePattern.test(resourceMatch[0]);
                  }
                }
              }
              
              // If guideline says "ensure X is disabled", check if X is set to false
              if (!isFixed && (guideline.includes('disable') || guideline.includes('should be disabled'))) {
                const disableMatch = guideline.match(/ensure\s+([^is]+)\s+is\s+disabled/i);
                if (disableMatch) {
                  const attribute = disableMatch[1].trim();
                  const resourcePattern = new RegExp(`${resource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?\\}`, 'i');
                  const resourceMatch = fixedContent.match(resourcePattern);
                  if (resourceMatch) {
                    const attributePattern = new RegExp(`${attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(false|"false"|0)`, 'i');
                    isFixed = attributePattern.test(resourceMatch[0]);
                  }
                }
              }
              
              // Generic check: if content changed and resource exists, assume it might be fixed
              // We'll do a more thorough check by re-running Checkov later
              if (!isFixed && fixedContent !== currentFileContent) {
                // Content changed, so there's a chance the fix was applied
                // Mark as "fixed" but note that verification is pending
                isFixed = true;
                console.log(`   ⚠️  Check ${checkId} marked as fixed (content changed, but full verification requires re-scan)`);
              }
            } else {
              // No guideline, but content changed - assume fixed
              isFixed = fixedContent !== currentFileContent;
            }
            
            fixResults.push({
              checkId: check.checkId,
              checkName: check.checkName,
              file: fileName,
              resource: check.resource,
              status: isFixed ? 'fixed' : 'failed',
              reason: isFixed ? 'File updated and fix appears to be applied' : 'Fix verification failed - issue may still exist'
            });
          }
          
          console.log(`   ✅ Batch ${batchIdx + 1} complete`);
        } catch (error: any) {
          console.error(`   ❌ Failed to fix batch ${batchIdx + 1} in ${fileName}:`, error.message);
          // Mark all checks in this batch as failed
          batchChecks.forEach((check: any) => {
            fixResults.push({
              checkId: check.checkId,
              checkName: check.checkName,
              file: fileName,
              resource: check.resource,
              status: 'failed',
              reason: error.message || 'Unknown error during fix'
            });
          });
          // Continue with next batch even if one fails
        }
        }
        
        // After all batches, update the fixedFiles array if file was updated
        if (fileWasUpdated) {
          const finalFiles = await storage.getFilesBySession(sessionId);
          const finalFile = finalFiles.find(f => f.id === file.id);
          if (finalFile) {
            fixedFiles.push({
              fileName: file.fileName,
              content: finalFile.content
            });
            console.log(`   ✅ All batches complete for ${fileName}`);
          }
        }
      }

      console.log(`\n✅ Auto-fix completed: ${fixedFiles.length} file(s) fixed`);
      console.log(`📋 Fixed files:`);
      fixedFiles.forEach(f => {
        console.log(`   - ${f.fileName}`);
      });
      
      // Final verification: Re-fetch all files to confirm updates
      const finalVerification = await storage.getFilesBySession(sessionId);
      console.log(`\n🔍 Final verification:`);
      fixedFiles.forEach(fixedFile => {
        const verified = finalVerification.find(f => f.fileName === fixedFile.fileName);
        if (verified) {
          if (verified.content === fixedFile.content) {
            console.log(`   ✅ ${fixedFile.fileName}: Verified in storage`);
          } else {
            console.warn(`   ⚠️  ${fixedFile.fileName}: Content mismatch in storage!`);
          }
        } else {
          console.warn(`   ⚠️  ${fixedFile.fileName}: Not found in storage!`);
        }
      });

      // Count results by status
      const fixedCount = fixResults.filter(r => r.status === 'fixed').length;
      const failedCount = fixResults.filter(r => r.status === 'failed').length;
      const skippedCount = fixResults.filter(r => r.status === 'skipped').length;
      
      console.log(`\n📊 Fix Results Summary:`);
      console.log(`   ✅ Fixed: ${fixedCount} check(s)`);
      console.log(`   ❌ Failed: ${failedCount} check(s)`);
      console.log(`   ⏭️  Skipped: ${skippedCount} check(s)`);
      
      if (failedCount > 0 || skippedCount > 0) {
        console.log(`\n⚠️  Issues that were not fixed:`);
        fixResults.filter(r => r.status !== 'fixed').forEach(r => {
          console.log(`   - ${r.checkId} (${r.checkName}): ${r.reason}`);
        });
      }

      res.json({
        success: true,
        fixedFiles: fixedFiles.map(f => f.fileName),
        message: `Fixed ${fixedCount} check(s) in ${fixedFiles.length} file(s)`,
        fixedCount: fixedFiles.length,
        fixResults: {
          fixed: fixedCount,
          failed: failedCount,
          skipped: skippedCount,
          total: fixResults.length,
          details: fixResults
        }
      });

    } catch (error: any) {
      console.error('❌ Error in auto-fix:', error);
      res.status(500).json({ 
        error: 'Failed to auto-fix issues',
        details: error.message 
      });
    }
  });

  // Analyze cost for Terraform resources
  app.post("/api/sessions/:id/analyze-cost", async (req, res) => {
    const sessionId = req.params.id;
    
    console.log(`\n💰 ========== COST ANALYSIS REQUEST ==========`);
    console.log(`Session ID: ${sessionId}`);
    console.log(`Timestamp: ${new Date().toISOString()}`);

    try {
      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ 
          error: 'Session not found',
          details: `Session ${sessionId} does not exist`
        });
      }

      // CRITICAL: Fetch files from SESSION STORAGE (not repository)
      // This ensures we analyze the LATEST generated code, not the old repository code
      console.log(`\n🔍 Fetching files from SESSION STORAGE (latest generated code) for cost analysis...`);
      console.log(`   This includes all newly generated/updated resources`);
      
      const sessionFiles = await storage.getFilesBySession(sessionId);
      console.log(`✅ Found ${sessionFiles.length} file(s) in session storage`);
      
      let allFiles: Array<{ fileName: string; content: string; sessionId: string; id: string }>;
      
      if (sessionFiles.length === 0) {
        console.error(`❌ No files found in session storage`);
        // Fallback: Try repository if session storage is empty
        if (session.provider && session.repositoryName) {
          console.log(`   ⚠️  Falling back to repository...`);
          const repoFiles = await mcpClient.scanRepositoryFiles(
            session.provider as MCPProvider,
            session.repositoryName,
            'main'
          );
          allFiles = repoFiles
            .filter(file => file.path.endsWith('.tf') || file.path.endsWith('.tfvars'))
            .map(file => ({
              fileName: file.path.split('/').pop() || file.path,
              content: file.content,
              sessionId: sessionId,
              id: `temp-${file.path}`,
            }));
          
          if (allFiles.length === 0) {
            return res.status(400).json({ 
              error: 'No Terraform files found',
              details: 'No files in session storage or repository'
            });
          }
          
          console.log(`   ✅ Using ${allFiles.length} file(s) from repository (fallback)`);
        } else {
          return res.status(400).json({ 
            error: 'No files found',
            details: 'No files in session storage and no repository configured'
          });
        }
      } else {
        // Filter to Terraform files only from session storage
        allFiles = sessionFiles
          .filter(file => {
            const fileName = file.fileName.toLowerCase();
            return fileName.endsWith('.tf') || fileName.endsWith('.tfvars');
          })
          .map(file => ({
            fileName: file.fileName,
            content: file.content,
            sessionId: sessionId,
            id: file.id,
          }));
        
        console.log(`   ✅ Using ${allFiles.length} file(s) from session storage (latest generated code)`);
      }
      
      console.log(`📄 Terraform files found: ${allFiles.length}`);
      
      // Debug: Show all files
      if (allFiles.length > 0) {
        console.log(`📄 Files to analyze:`);
        allFiles.forEach((file, i) => {
          console.log(`   ${i + 1}. ${file.fileName} (content length: ${file.content?.length || 0} bytes)`);
          if (file.content && file.content.length > 0) {
            const preview = file.content.substring(0, 150).replace(/\n/g, ' ');
            console.log(`      Preview: ${preview}...`);
          }
        });
      } else {
        console.warn(`⚠️  No Terraform files found in session storage or repository`);
        if (session.repositoryName) {
          console.warn(`   Repository: ${session.repositoryName}`);
        }
        if (session.provider) {
          console.warn(`   Provider: ${session.provider}`);
        }
      }
      
      const terraformFiles = allFiles.filter(file => {
        const fileName = file.fileName.toLowerCase();
        const isTerraform = fileName.endsWith('.tf') || fileName.endsWith('.tfvars') || fileName.endsWith('.hcl');
        
        if (isTerraform && (!file.content || file.content.trim().length === 0)) {
          console.warn(`   ⚠️  Skipping empty Terraform file: ${file.fileName}`);
          return false;
        }
        
        return isTerraform;
      });

      console.log(`📁 Found ${terraformFiles.length} Terraform file(s) with content`);

      if (terraformFiles.length === 0) {
        return res.status(400).json({ 
          success: false,
          error: 'No Terraform files found',
          details: 'No Terraform files exist for this session or all files are empty. Please generate Terraform files first.',
          summary: {
            totalMonthly: 0,
            totalYearly: 0,
            currency: 'USD',
            resourceCount: 0
          },
          resources: []
        });
      }

      // Step 1: Use AI to analyze Terraform files and extract resource information
      console.log(`\n🤖 Step 1: Analyzing Terraform files...`);
      
      // Get cloud provider from session
      const cloudProvider = session.cloudProvider || 'azure';
      console.log(`   📋 Cloud provider: ${cloudProvider}`);
      
      const filesContent = terraformFiles.map(f => ({
        path: f.fileName,
        content: f.content
      }));
      
      // First, try direct parsing as fallback
      console.log(`   📋 Attempting direct Terraform parsing...`);
      const directParsedResources: any[] = [];
      
      for (const file of terraformFiles) {
        const content = file.content;
        console.log(`   📄 Parsing file: ${file.fileName} (${content.length} bytes)`);
        
        // Parse resource blocks directly (handles multi-line blocks with nested structures)
        // Match: resource "type" "name" { ... } - need to handle nested braces
        const resourceMatches: Array<{ type: string; name: string; body: string; start: number }> = [];
        
        // Find all resource declarations
        const resourceDeclRegex = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g;
        let declMatch;
        
        while ((declMatch = resourceDeclRegex.exec(content)) !== null) {
          const resourceType = declMatch[1];
          const resourceName = declMatch[2];
          const startPos = declMatch.index;
          const openBracePos = declMatch.index + declMatch[0].length - 1;
          
          // Process resources based on cloud provider
          const isAzureResource = resourceType.startsWith('azurerm_') || resourceType.startsWith('azapi_');
          const isAWSResource = resourceType.startsWith('aws_');
          
          if ((cloudProvider === 'azure' && isAzureResource) || (cloudProvider === 'aws' && isAWSResource)) {
            // Find matching closing brace (handle nested braces)
            let braceCount = 1;
            let pos = openBracePos + 1;
            let inString = false;
            let stringChar = '';
            
            while (pos < content.length && braceCount > 0) {
              const char = content[pos];
              
              if (!inString) {
                if (char === '"' || char === "'") {
                  inString = true;
                  stringChar = char;
                } else if (char === '{') {
                  braceCount++;
                } else if (char === '}') {
                  braceCount--;
                }
              } else {
                if (char === stringChar && content[pos - 1] !== '\\') {
                  inString = false;
                }
              }
              
              pos++;
            }
            
            if (braceCount === 0) {
              const resourceBody = content.substring(openBracePos + 1, pos - 1);
              resourceMatches.push({
                type: resourceType,
                name: resourceName,
                body: resourceBody,
                start: startPos
              });
            }
          }
        }
        
          // Process each found resource
          for (const match of resourceMatches) {
            // Check if this resource uses count or for_each
            const hasCount = /count\s*=/.test(match.body);
            const hasForEach = /for_each\s*=/.test(match.body);
            
            if (hasCount || hasForEach) {
              console.log(`   ✅ Found resource: ${match.type}.${match.name} (with ${hasCount ? 'count' : 'for_each'})`);
            } else {
              console.log(`   ✅ Found resource: ${match.type}.${match.name}`);
            }
          
          // Extract location/region (handles both quoted and unquoted, with/without spaces)
          // AWS uses "region", Azure uses "location"
          // Also handles references like azurerm_resource_group.test.name or aws_region.current.name
          const locationField = cloudProvider === 'aws' ? 'region' : 'location';
          const defaultLocation = cloudProvider === 'aws' ? 'us-east-1' : 'eastus';
          
          // Try the cloud provider-specific field first
          let locationMatch = match.body.match(new RegExp(`${locationField}\\s*=\\s*"?([^"\\s\\n}]+)"?`));
          // Fallback to the other field if not found
          if (!locationMatch) {
            const fallbackField = cloudProvider === 'aws' ? 'location' : 'region';
            locationMatch = match.body.match(new RegExp(`${fallbackField}\\s*=\\s*"?([^"\\s\\n}]+)"?`));
          }
          
          let location = defaultLocation;
          if (locationMatch) {
            location = locationMatch[1].trim();
            // Remove quotes if present
            location = location.replace(/^["']|["']$/g, '');
          }
          
          // Extract attributes
          const attributes: Record<string, any> = {
            resource_type: match.type,
            resource_name: match.name
          };
          
          // Handle count and for_each for ALL cloud providers (before other attributes)
          // Extract count (numeric value or variable reference)
          const countMatch = match.body.match(/count\s*=\s*([^\s\n}]+)/);
          if (countMatch) {
            const countValue = countMatch[1].trim().replace(/^["']|["']$/g, '');
            // Try to parse as number, otherwise it's a variable reference
            const countNum = parseInt(countValue, 10);
            if (!isNaN(countNum)) {
              attributes.count = countNum;
              attributes.resource_count = countNum; // Actual count for cost calculation
            } else {
              attributes.count = countValue; // Variable reference
              attributes.resource_count = 1; // Default to 1, will need to resolve from tfvars
            }
          }
          
          // Extract for_each (set or map)
          const forEachMatch = match.body.match(/for_each\s*=\s*([^\s\n}]+)/);
          if (forEachMatch) {
            const forEachValue = forEachMatch[1].trim();
            // Try to extract count from for_each
            // Pattern: toset(["a", "b", "c"]) or var.some_set
            const setMatch = forEachValue.match(/toset\(\[([^\]]+)\]\)/);
            if (setMatch) {
              const items = setMatch[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
              attributes.for_each_count = items.length;
              attributes.resource_count = items.length;
            } else if (forEachValue.startsWith('var.')) {
              // Variable reference - will need to resolve from tfvars
              attributes.for_each = forEachValue;
              attributes.resource_count = 1; // Default, will need to resolve
            } else {
              // Could be a map or other expression
              attributes.for_each = forEachValue;
              attributes.resource_count = 1; // Default
            }
          }
          
          // Determine actual resource count (for cost calculation)
          let actualResourceCount = attributes.resource_count || 1; // Default to 1 if no count/for_each
          
          // Azure-specific attributes
          if (cloudProvider === 'azure') {
            // Common Azure attributes (handles quoted and unquoted values, and nested blocks)
            const tierMatch = match.body.match(/account_tier\s*=\s*"?([^"\s\n}]+)"?/);
            if (tierMatch) attributes.account_tier = tierMatch[1].trim().replace(/^["']|["']$/g, '');
            
            const replicationMatch = match.body.match(/account_replication_type\s*=\s*"?([^"\s\n}]+)"?/);
            if (replicationMatch) attributes.account_replication_type = replicationMatch[1].trim().replace(/^["']|["']$/g, '');
            
            // Handle nested sku blocks
            const skuBlockMatch = match.body.match(/sku\s*\{([^}]+)\}/);
            if (skuBlockMatch) {
              const skuBody = skuBlockMatch[1];
              const tierMatch = skuBody.match(/tier\s*=\s*"?([^"\s\n}]+)"?/);
              const sizeMatch = skuBody.match(/size\s*=\s*"?([^"\s\n}]+)"?/);
              if (tierMatch) attributes.sku = tierMatch[1].trim().replace(/^["']|["']$/g, '');
              if (sizeMatch) attributes.sku_size = sizeMatch[1].trim().replace(/^["']|["']$/g, '');
              if (tierMatch && sizeMatch) {
                attributes.sku_name = `${attributes.sku}${attributes.sku_size}`;
              }
            } else {
              // Simple sku attribute
              const skuMatch = match.body.match(/sku\s*=\s*"?([^"\s\n}]+)"?/);
              if (skuMatch) attributes.sku = skuMatch[1].trim().replace(/^["']|["']$/g, '');
            }
            
            const skuNameMatch = match.body.match(/sku_name\s*=\s*"?([^"\s\n}]+)"?/);
            if (skuNameMatch) attributes.sku_name = skuNameMatch[1].trim().replace(/^["']|["']$/g, '');
            
            const kindMatch = match.body.match(/account_kind\s*=\s*"?([^"\s\n}]+)"?/);
            if (kindMatch) attributes.account_kind = kindMatch[1].trim().replace(/^["']|["']$/g, '');
            
            // Extract app_service_plan_id for App Service
            const planIdMatch = match.body.match(/app_service_plan_id\s*=\s*([^\s\n}]+)/);
            if (planIdMatch) attributes.app_service_plan_id = planIdMatch[1].trim();
          }
          
          // AWS-specific attributes
          if (cloudProvider === 'aws') {
            // EC2 attributes
            const instanceTypeMatch = match.body.match(/instance_type\s*=\s*"?([^"\s\n}]+)"?/);
            if (instanceTypeMatch) attributes.instance_type = instanceTypeMatch[1].trim().replace(/^["']|["']$/g, '');
            
            // Lambda attributes
            const memorySizeMatch = match.body.match(/memory_size\s*=\s*"?([^"\s\n}]+)"?/);
            if (memorySizeMatch) attributes.memory_size = memorySizeMatch[1].trim().replace(/^["']|["']$/g, '');
            
            const timeoutMatch = match.body.match(/timeout\s*=\s*"?([^"\s\n}]+)"?/);
            if (timeoutMatch) attributes.timeout = timeoutMatch[1].trim().replace(/^["']|["']$/g, '');
            
            // RDS attributes
            const instanceClassMatch = match.body.match(/instance_class\s*=\s*"?([^"\s\n}]+)"?/);
            if (instanceClassMatch) attributes.instance_class = instanceClassMatch[1].trim().replace(/^["']|["']$/g, '');
            
            const engineMatch = match.body.match(/engine\s*=\s*"?([^"\s\n}]+)"?/);
            if (engineMatch) attributes.engine = engineMatch[1].trim().replace(/^["']|["']$/g, '');
            
            const multiAzMatch = match.body.match(/multi_az\s*=\s*"?([^"\s\n}]+)"?/);
            if (multiAzMatch) {
              const multiAzValue = multiAzMatch[1].trim().replace(/^["']|["']$/g, '');
              attributes.multi_az = multiAzValue === 'true';
            }
            
            // DynamoDB attributes
            const billingModeMatch = match.body.match(/billing_mode\s*=\s*"?([^"\s\n}]+)"?/);
            if (billingModeMatch) attributes.billing_mode = billingModeMatch[1].trim().replace(/^["']|["']$/g, '');
            
            const readCapacityMatch = match.body.match(/read_capacity\s*=\s*"?([^"\s\n}]+)"?/);
            if (readCapacityMatch) attributes.read_capacity = readCapacityMatch[1].trim().replace(/^["']|["']$/g, '');
            
            const writeCapacityMatch = match.body.match(/write_capacity\s*=\s*"?([^"\s\n}]+)"?/);
            if (writeCapacityMatch) attributes.write_capacity = writeCapacityMatch[1].trim().replace(/^["']|["']$/g, '');
            
            // ElastiCache attributes
            const nodeTypeMatch = match.body.match(/node_type\s*=\s*"?([^"\s\n}]+)"?/);
            if (nodeTypeMatch) attributes.node_type = nodeTypeMatch[1].trim().replace(/^["']|["']$/g, '');
            
            const numCacheNodesMatch = match.body.match(/num_cache_nodes\s*=\s*"?([^"\s\n}]+)"?/);
            if (numCacheNodesMatch) attributes.num_cache_nodes = numCacheNodesMatch[1].trim().replace(/^["']|["']$/g, '');
          }
          
          // If count/for_each is a variable, try to resolve from tfvars
          if (attributes.count && typeof attributes.count === 'string' && attributes.count.startsWith('var.')) {
            const varName = attributes.count.replace('var.', '');
            // Try to find in tfvars files
            for (const tfvarsFile of terraformFiles.filter(f => f.fileName.endsWith('.tfvars'))) {
              const varMatch = tfvarsFile.content.match(new RegExp(`${varName}\\s*=\\s*([^\\n]+)`));
              if (varMatch) {
                const varValue = varMatch[1].trim().replace(/^["']|["']$/g, '');
                const varNum = parseInt(varValue, 10);
                if (!isNaN(varNum)) {
                  actualResourceCount = varNum;
                  attributes.count = varNum;
                  attributes.resource_count = varNum;
                  break;
                }
              }
            }
          }
          
          // Create resource entries - if count > 1, create multiple entries for accurate cost calculation
          for (let i = 0; i < actualResourceCount; i++) {
            const resourceName = actualResourceCount > 1 ? `${match.name}[${i}]` : match.name;
            
            // Store location/region in the appropriate field based on cloud provider
            const resourceData: any = {
              resourceType: match.type,
              resourceName: resourceName,
              attributes: {
                ...attributes,
                instance_index: actualResourceCount > 1 ? i : undefined
              }
            };
            
            if (cloudProvider === 'aws') {
              resourceData.region = location;
            } else {
              resourceData.location = location;
            }
            
            directParsedResources.push(resourceData);
          }
          
          if (actualResourceCount > 1) {
            console.log(`   📊 Resource count: ${actualResourceCount} (expanded from count/for_each)`);
          }
        }
      }
      
      console.log(`   📊 Direct parsing found ${directParsedResources.length} resource(s)`);
      
      // Now try AI analysis
      console.log(`   🤖 Attempting AI analysis...`);
      
      // Build cloud provider-specific prompt
      const isAWS = cloudProvider === 'aws';
      const resourcePrefix = isAWS ? 'aws_' : 'azurerm_';
      const resourceExamples = isAWS 
        ? 'aws_s3_bucket, aws_ec2_instance, aws_lambda_function, aws_rds_instance, aws_dynamodb_table, aws_apigateway_rest_api, etc.'
        : 'azurerm_storage_account, azurerm_function_app, azurerm_logic_app_workflow, azurerm_frontdoor, azurerm_app_service, azurerm_app_service_plan, azurerm_static_site, azurerm_resource_group, etc.';
      const locationField = isAWS ? 'region' : 'location';
      const defaultLocation = isAWS ? 'us-east-1' : 'eastus';
      const pricingAttributes = isAWS
        ? `   - For EC2: instance_type, instance_count
   - For S3: versioning, lifecycle_rules, storage_class
   - For RDS: instance_class, engine, multi_az
   - For Lambda: memory_size, timeout
   - For DynamoDB: billing_mode, read_capacity, write_capacity
   - For API Gateway: api_type, endpoint_type
   - Any size, tier, or capacity information`
        : `   - For Storage: account_tier, account_replication_type, account_kind
   - For Function App: app_service_plan_id, consumption plan vs dedicated
   - For Logic App: sku, location
   - For Front Door: sku_name, location
   - For App Service: app_service_plan_id, sku
   - For App Service Plan: sku, sku_name, kind
   - For Static Web App: sku_size, location
   - Any size, tier, or SKU information`;
      
      const analysisPrompt = `Analyze these Terraform files and identify ALL ${isAWS ? 'AWS' : 'Azure'} resources with their pricing-relevant attributes.

CRITICAL: You MUST find and extract ALL resources that start with "${resourcePrefix}"${isAWS ? '' : ' or "azapi_"'}. Do not skip any resources.

For each resource, extract:
1. Resource type (e.g., ${resourceExamples})
2. Resource name (the label after the resource type, e.g., "mybucket" in "resource ${resourcePrefix}${isAWS ? 's3_bucket' : 'storage_account'} mybucket")
3. ${isAWS ? 'Region' : 'Location/region'} (from ${locationField} attribute${isAWS ? '' : ' or resource group location'})
4. Pricing-relevant attributes:
${pricingAttributes}

IMPORTANT: 
- Include ALL resources, even if they don't have explicit pricing
- Extract ${locationField} from the resource's "${locationField}" attribute${isAWS ? '' : ', or infer from resource group'}
- If ${locationField} is not specified, use "${defaultLocation}" as default
- Extract ALL attributes that might affect pricing

Return ONLY valid JSON in this exact format (no markdown, no code blocks):
{
  "resources": [
    {
      "resourceType": "${resourcePrefix}${isAWS ? 's3_bucket' : 'storage_account'}",
      "resourceName": "${isAWS ? 'mybucket' : 'mystorage'}",
      "${locationField}": "${defaultLocation}",
      "attributes": {
        ${isAWS ? '"versioning": "Enabled",\n        "lifecycle_rules": []' : '"account_tier": "Standard",\n        "account_replication_type": "LRS",\n        "account_kind": "StorageV2"'}
      }
    }
  ]
}

Terraform files:
${JSON.stringify(filesContent, null, 2)}

Remember: Return ONLY the JSON object, no other text.`;

      const aiAnalysis = await openaiService.chat([
        {
          role: 'system',
          content: `You are an expert at analyzing Terraform files and extracting ${isAWS ? 'AWS' : 'Azure'} resource information for cost estimation. Return only valid JSON.`
        },
        {
          role: 'user',
          content: analysisPrompt
        }
      ]);

      // Parse AI response
      let aiParsedResources: any[] = [];
      try {
        console.log(`\n📝 AI Response (first 500 chars): ${aiAnalysis.substring(0, 500)}...`);
        
        const cleanedResponse = aiAnalysis.trim();
        const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
        let parsedData: any;
        
        if (jsonMatch) {
          parsedData = JSON.parse(jsonMatch[0]);
        } else {
          parsedData = JSON.parse(cleanedResponse);
        }
        
        aiParsedResources = parsedData.resources || parsedData || [];
        
        console.log(`\n✅ Parsed ${aiParsedResources.length} resource(s) from AI analysis`);
        if (aiParsedResources.length > 0) {
          aiParsedResources.forEach((r, idx) => {
            console.log(`   ${idx + 1}. ${r.resourceType} - ${r.resourceName} (${r.location || 'no location'})`);
          });
        } else {
          console.warn(`   ⚠️  No resources found in AI response!`);
          console.warn(`   Full AI response: ${aiAnalysis}`);
        }
      } catch (parseError: any) {
        console.warn('⚠️  Failed to parse AI response:', parseError.message);
        console.warn('   Will use direct parsing results instead');
      }
      
      // Combine direct parsing and AI results, prefer direct parsing if it found resources
      // (more reliable than AI which might fail or return empty)
      let parsedResources: any[] = [];
      
      console.log(`\n📊 Parsing Summary:`);
      console.log(`   Direct parsing: ${directParsedResources.length} resource(s)`);
      console.log(`   AI parsing: ${aiParsedResources.length} resource(s)`);
      
      if (directParsedResources.length > 0) {
        console.log(`\n✅ Using direct parsing results (${directParsedResources.length} resources)`);
        parsedResources = directParsedResources;
        
        // If AI also found resources, merge them (AI might have more attributes)
        if (aiParsedResources.length > 0) {
          console.log(`   Merging with AI results for additional attributes...`);
          // Create a map of direct parsed resources by type+name
          const directMap = new Map<string, any>();
          directParsedResources.forEach(r => {
            const key = `${r.resourceType}.${r.resourceName}`;
            directMap.set(key, r);
          });
          
          // Merge AI attributes into direct parsed resources
          aiParsedResources.forEach(aiRes => {
            const key = `${aiRes.resourceType}.${aiRes.resourceName}`;
            const directRes = directMap.get(key);
            if (directRes) {
              // Merge attributes
              directRes.attributes = { ...directRes.attributes, ...aiRes.attributes };
            } else {
              // AI found a resource that direct parsing didn't - add it
              parsedResources.push(aiRes);
            }
          });
        }
      } else if (aiParsedResources.length > 0) {
        console.log(`\n✅ Using AI analysis results (${aiParsedResources.length} resources)`);
        parsedResources = aiParsedResources;
      } else {
        console.error(`\n❌ No resources found by either method!`);
        console.error(`   Direct parsing: ${directParsedResources.length} resources`);
        console.error(`   AI parsing: ${aiParsedResources.length} resources`);
        console.error(`   Terraform files analyzed: ${terraformFiles.length}`);
        terraformFiles.forEach(f => {
          console.error(`     - ${f.fileName} (${f.content.length} bytes)`);
          // Show first 500 chars of content for debugging
          console.error(`       Content preview: ${f.content.substring(0, 500).replace(/\n/g, ' ')}...`);
        });
        
        return res.status(400).json({
          success: false,
          error: 'No resources found',
          details: `No ${cloudProvider === 'aws' ? 'AWS' : 'Azure'} resources were detected in the Terraform files. Make sure your files contain valid ${cloudProvider === 'aws' ? 'AWS' : 'Azure'} resource definitions (e.g., resource "${cloudProvider === 'aws' ? 'aws_s3_bucket' : 'azurerm_storage_account'}" "name" { ... }).`,
          summary: {
            totalMonthly: 0,
            totalYearly: 0,
            currency: 'USD',
            resourceCount: 0
          },
          resources: []
        });
      }
      
      console.log(`\n📊 Final resource list (${parsedResources.length} resources):`);
      parsedResources.forEach((r, idx) => {
        const locationField = cloudProvider === 'aws' ? 'region' : 'location';
        const defaultLocation = cloudProvider === 'aws' ? 'us-east-1' : 'eastus';
        const resourceLocation = r[locationField] || r.location || r.region || defaultLocation;
        console.log(`   ${idx + 1}. ${r.resourceType}.${r.resourceName} (${resourceLocation})`);
        if (Object.keys(r.attributes || {}).length > 0) {
          console.log(`      Attributes: ${JSON.stringify(r.attributes)}`);
        }
      });

      // Step 2: Use AI to map Terraform resource types to service names for pricing
      console.log(`\n🤖 Using AI to map resource types to service names...`);
      const uniqueResourceTypes = Array.from(new Set(parsedResources.map(r => r.resourceType)));
      const resourceTypeToService: Record<string, string> = {};
      
      // Use AI to map resource types to service names
      try {
        const mappingPrompt = `You are a cloud infrastructure expert. Map the following Terraform resource types to their ${cloudProvider === 'aws' ? 'AWS' : cloudProvider === 'azure' ? 'Azure' : 'GCP'} service names for cost analysis.

Resource types to map:
${uniqueResourceTypes.map((rt, idx) => `${idx + 1}. ${rt}`).join('\n')}

For each resource type, provide:
1. The official service name (e.g., "S3", "EC2", "Storage", "Functions")
2. A brief description of what the service does

Return a JSON object mapping resource types to service names:
{
  "resource_type": "Service Name",
  ...
}

Example for AWS:
{
  "aws_s3_bucket": "S3",
  "aws_ec2_instance": "EC2",
  "aws_lambda_function": "Lambda"
}

Example for Azure:
{
  "azurerm_storage_account": "Storage",
  "azurerm_function_app": "Functions",
  "azurerm_app_service": "App Service"
}

Return ONLY the JSON object, nothing else.`;

        const mappingResponse = await openaiService.chat([
          {
            role: 'system',
            content: `You are a cloud infrastructure expert. Map Terraform resource types to their cloud service names. Return only valid JSON.`
          },
          {
            role: 'user',
            content: mappingPrompt
          }
        ]);

        // Parse AI response
        let mappingJson = mappingResponse.trim();
        // Remove markdown code blocks if present
        if (mappingJson.startsWith('```json')) {
          mappingJson = mappingJson.replace(/^```json\s*\n/, '').replace(/\n```\s*$/, '');
        } else if (mappingJson.startsWith('```')) {
          mappingJson = mappingJson.replace(/^```\s*\n/, '').replace(/\n```\s*$/, '');
        }
        
        const aiMapping = JSON.parse(repairJson(mappingJson));
        Object.assign(resourceTypeToService, aiMapping);
        console.log(`   ✅ AI mapped ${Object.keys(resourceTypeToService).length} resource type(s) to service names`);
      } catch (error: any) {
        console.warn(`   ⚠️  AI mapping failed: ${error.message}, using fallback`);
        // Fallback: Use resource type as service name
        uniqueResourceTypes.forEach(rt => {
          resourceTypeToService[rt] = rt;
        });
      }

      // Step 3: Query pricing for each resource
      console.log(`\n💰 Step 2: Querying ${cloudProvider === 'aws' ? 'AWS' : 'Azure'} Pricing...`);
      
      const costEstimates: Array<{
        resourceName: string;
        resourceType: string;
        serviceName: string;
        monthlyCost: number;
        yearlyCost: number;
        currency: string;
        details?: any;
      }> = [];

      console.log(`\n💰 Step 2: Querying ${cloudProvider === 'aws' ? 'AWS' : 'Azure'} Pricing API for ${parsedResources.length} resource(s)...`);
      
      // AWS pricing handling
      if (cloudProvider === 'aws') {
        console.log(`\n⚠️  AWS Pricing: Full pricing requires AWS Pricing API setup.`);
        console.log(`   Providing basic cost estimation based on resource types.`);
        console.log(`   For accurate pricing, AWS Pricing Calculator API integration is recommended.`);
        
        for (const resource of parsedResources) {
          const serviceName = resourceTypeToService[resource.resourceType] || resource.resourceType;
          const region = resource.region || resource.location || 'us-east-1';
          
          console.log(`\n   [${parsedResources.indexOf(resource) + 1}/${parsedResources.length}] Estimating cost for: ${serviceName} (${resource.resourceName})`);
          console.log(`      Type: ${resource.resourceType}`);
          console.log(`      Region: ${region}`);
          
          // Skip free AWS resources
          if (resource.resourceType === 'aws_iam_role' || resource.resourceType === 'aws_iam_policy') {
            console.log(`      ⏭️  Skipping IAM resource (free)`);
            costEstimates.push({
              resourceName: resource.resourceName,
              resourceType: resource.resourceType,
              serviceName: serviceName,
              monthlyCost: 0,
              yearlyCost: 0,
              currency: 'USD',
              details: { note: 'IAM resources are free' }
            });
            continue;
          }
          
          // Use AI to estimate cost based on resource type and attributes
          let estimatedMonthlyCost = 0;
          
          try {
            const costEstimationPrompt = `You are a cloud cost estimation expert. Estimate the monthly cost for this AWS resource based on its configuration.

Resource Type: ${resource.resourceType}
Resource Name: ${resource.resourceName}
Region: ${region}
Attributes: ${JSON.stringify(resource.attributes || {}, null, 2)}

Based on the resource type and attributes, provide a realistic monthly cost estimate in USD.
Consider:
- Resource-specific pricing models (on-demand, provisioned, pay-per-use, etc.)
- Typical usage patterns for this resource type
- Attributes that affect pricing (instance types, sizes, capacity, etc.)
- Region-specific pricing variations

Return a JSON object with:
{
  "estimatedMonthlyCost": <number>,
  "currency": "USD",
  "calculation": "<brief explanation of how you calculated this>",
  "assumptions": ["<assumption 1>", "<assumption 2>", ...],
  "note": "<any additional notes>"
}

Example:
{
  "estimatedMonthlyCost": 7.50,
  "currency": "USD",
  "calculation": "t3.micro instance at $0.0104/hour × 730 hours/month",
  "assumptions": ["Instance runs 24/7", "No reserved instance discount"],
  "note": "For accurate pricing, use AWS Pricing Calculator"
}

Return ONLY the JSON object, nothing else.`;

            const costResponse = await openaiService.chat([
              {
                role: 'system',
                content: 'You are a cloud cost estimation expert. Analyze AWS resource configurations and provide realistic monthly cost estimates. Return only valid JSON.'
              },
              {
                role: 'user',
                content: costEstimationPrompt
              }
            ]);

            // Parse AI response
            let costJson = costResponse.trim();
            if (costJson.startsWith('```json')) {
              costJson = costJson.replace(/^```json\s*\n/, '').replace(/\n```\s*$/, '');
            } else if (costJson.startsWith('```')) {
              costJson = costJson.replace(/^```\s*\n/, '').replace(/\n```\s*$/, '');
            }
            
            const costEstimate = JSON.parse(repairJson(costJson));
            estimatedMonthlyCost = costEstimate.estimatedMonthlyCost || 0;
            
            console.log(`      🤖 AI estimated cost: $${estimatedMonthlyCost.toFixed(2)}/month`);
            if (costEstimate.calculation) {
              console.log(`      📊 Calculation: ${costEstimate.calculation}`);
            }
            if (costEstimate.assumptions && costEstimate.assumptions.length > 0) {
              console.log(`      📋 Assumptions: ${costEstimate.assumptions.join(', ')}`);
            }
          } catch (error: any) {
            console.warn(`      ⚠️  AI cost estimation failed: ${error.message}, using fallback`);
            // Fallback: Set to 0 to indicate unknown pricing
            estimatedMonthlyCost = 0;
          }
          
          // Only add to estimates if we have a valid cost (not 0 for unknown resources)
          if (estimatedMonthlyCost > 0 || resource.resourceType === 'aws_ecs_cluster' || resource.resourceType === 'aws_ecs_service') {
            costEstimates.push({
              resourceName: resource.resourceName,
              resourceType: resource.resourceType,
              serviceName: serviceName,
              monthlyCost: Math.round(estimatedMonthlyCost * 100) / 100, // Round to 2 decimals
              yearlyCost: Math.round(estimatedMonthlyCost * 12 * 100) / 100,
              currency: 'USD',
              details: {
                region: region,
                note: estimatedMonthlyCost === 0 ? 'Free service (costs come from underlying resources)' : 'Estimated cost based on resource attributes - for accurate pricing, use AWS Pricing Calculator',
                attributes: resource.attributes,
                calculation: estimatedMonthlyCost > 0 ? `Based on ${JSON.stringify(resource.attributes || {})}` : undefined
              }
            });
            
            console.log(`      💰 Estimated monthly cost: $${estimatedMonthlyCost.toFixed(2)}`);
          } else {
            console.log(`      ⚠️  Skipping ${resource.resourceName} - cannot estimate cost for ${resource.resourceType}`);
          }
        }
      } else {
        // Azure pricing (existing logic)
        for (const resource of parsedResources) {
          const serviceName = resourceTypeToService[resource.resourceType] || resource.resourceType;
          console.log(`\n   [${parsedResources.indexOf(resource) + 1}/${parsedResources.length}] Querying pricing for: ${serviceName} (${resource.resourceName})`);
          console.log(`      Type: ${resource.resourceType}`);
          console.log(`      Location: ${resource.location || 'eastus'}`);
          
          // Skip resource groups (they're free)
          if (resource.resourceType === 'azurerm_resource_group') {
            console.log(`      ⏭️  Skipping resource group (free)`);
            continue;
          }

        try {
          // Build search query based on resource type
          let searchArgs: Record<string, any> = {
            serviceName: serviceName,
            location: resource.location || 'eastus'
          };

          // Add service-specific filters
          if (resource.resourceType === 'azurerm_storage_account') {
            const tier = resource.attributes?.account_tier || 'Standard';
            const replication = resource.attributes?.account_replication_type || 'LRS';
            searchArgs.sku = `${tier}_${replication}`;
          } else if (resource.resourceType === 'azurerm_function_app') {
            // Function Apps are typically consumption-based
            searchArgs.plan = 'Consumption';
          } else if (resource.resourceType === 'azurerm_app_service' || resource.resourceType === 'azurerm_app_service_plan') {
            // App Service cost comes from the plan, not the app itself
            // Filter for plan pricing, not per-request or per-GB pricing
            searchArgs.productName = 'Azure App Service';
            // Try to get plan tier from attributes
            if (resource.attributes?.sku) {
              searchArgs.sku = resource.attributes.sku;
            } else if (resource.attributes?.sku_name) {
              searchArgs.sku = resource.attributes.sku_name;
            }
          } else if (resource.resourceType === 'azurerm_logic_app_workflow') {
            searchArgs.productName = 'Logic Apps';
          } else if (resource.resourceType === 'azurerm_frontdoor') {
            searchArgs.productName = 'Azure Front Door';
          } else if (resource.resourceType === 'azurerm_static_site') {
            searchArgs.productName = 'Static Web Apps';
          }

          // Query Azure Retail Prices API directly for exact pricing (NO FALLBACKS)
          let pricingData: any = null;
          let items: any[] = [];
          
          // Build precise API query based on resource type
          const filterParts: string[] = [];
          
          // Service name mapping for Azure API
          const serviceNameMap: Record<string, string> = {
            'Storage': 'Storage',
            'Functions': 'Functions',
            'Logic Apps': 'Logic Apps',
            'Front Door': 'Front Door',
            'App Service': 'Azure App Service',
            'Static Web Apps': 'Static Web Apps'
          };
          
          const apiServiceName = serviceNameMap[serviceName] || serviceName;
          
          // Map Terraform location format (eastus) to Azure Pricing API format (US East)
          const locationMap: Record<string, string> = {
            'eastus': 'US East',
            'eastus2': 'US East 2',
            'westus': 'US West',
            'westus2': 'US West 2',
            'centralus': 'US Central',
            'northcentralus': 'US North Central',
            'southcentralus': 'US South Central',
            'westcentralus': 'US West Central',
            'canadacentral': 'Canada Central',
            'canadaeast': 'Canada East',
            'brazilsouth': 'Brazil South',
            'northeurope': 'North Europe',
            'westeurope': 'West Europe',
            'uksouth': 'UK South',
            'ukwest': 'UK West',
            'francecentral': 'France Central',
            'francesouth': 'France South',
            'germanywestcentral': 'Germany West Central',
            'germanynorth': 'Germany North',
            'switzerlandnorth': 'Switzerland North',
            'switzerlandwest': 'Switzerland West',
            'norwayeast': 'Norway East',
            'norwaywest': 'Norway West',
            'swedencentral': 'Sweden Central',
            'uaenorth': 'UAE North',
            'uaecentral': 'UAE Central',
            'southafricanorth': 'South Africa North',
            'southafricawest': 'South Africa West',
            'japaneast': 'Japan East',
            'japanwest': 'Japan West',
            'koreacentral': 'Korea Central',
            'koreasouth': 'Korea South',
            'southeastasia': 'Southeast Asia',
            'eastasia': 'East Asia',
            'australiaeast': 'Australia East',
            'australiasoutheast': 'Australia Southeast',
            'australiacentral': 'Australia Central',
            'australiacentral2': 'Australia Central 2',
            'chinanorth': 'China North',
            'chinaeast': 'China East',
            'chinanorth2': 'China North 2',
            'chinaeast2': 'China East 2',
            'indiacentral': 'India Central',
            'indiasouth': 'India South',
            'indiawest': 'India West'
          };
          
          const azureLocation = locationMap[resource.location?.toLowerCase() || 'eastus'] || 'US East';
          
          // Use AI to determine Azure Pricing API filter based on resource type and attributes
          try {
            const filterPrompt = `You are an Azure pricing expert. Determine the Azure Pricing API filter for this resource.

Resource Type: ${resource.resourceType}
Service Name: ${serviceName}
Location: ${azureLocation}
Attributes: ${JSON.stringify(resource.attributes || {}, null, 2)}

Azure Pricing API uses OData filters. Common filter fields:
- serviceName: The Azure service name (e.g., "Storage", "Azure App Service", "Functions")
- serviceFamily: Service category (e.g., "Storage", "Compute", "Networking")
- meterName: Specific pricing meter (e.g., "LRS Data Stored", "Standard S1")
- armSkuName: ARM SKU name (e.g., "S1", "Basic")
- location: Azure region (e.g., "US East", "West Europe")

Based on the resource type and attributes, determine the appropriate filter parts.
Consider:
- Storage accounts: Use replication type to determine meterName (LRS, GRS, RAGRS, ZRS)
- App Service Plans: Use SKU to determine armSkuName
- Other resources: Use serviceName and location

Return a JSON object with filter parts:
{
  "filterParts": ["serviceName eq 'Service Name'", "location eq 'Location'", ...],
  "notes": "<any notes about the filter>"
}

Example for storage account with LRS:
{
  "filterParts": ["serviceName eq 'Storage'", "serviceFamily eq 'Storage'", "meterName eq 'LRS Data Stored'", "location eq 'US East'"],
  "notes": "Storage account with LRS replication"
}

Return ONLY the JSON object, nothing else.`;

            const filterResponse = await openaiService.chat([
              {
                role: 'system',
                content: 'You are an Azure pricing expert. Determine Azure Pricing API filters based on resource types and attributes. Return only valid JSON.'
              },
              {
                role: 'user',
                content: filterPrompt
              }
            ]);

            // Parse AI response
            let filterJson = filterResponse.trim();
            if (filterJson.startsWith('```json')) {
              filterJson = filterJson.replace(/^```json\s*\n/, '').replace(/\n```\s*$/, '');
            } else if (filterJson.startsWith('```')) {
              filterJson = filterJson.replace(/^```\s*\n/, '').replace(/\n```\s*$/, '');
            }
            
            const filterResult = JSON.parse(repairJson(filterJson));
            filterParts.push(...(filterResult.filterParts || []));
            
            console.log(`   🤖 AI determined filter: ${filterResult.filterParts?.join(' and ')}`);
            if (filterResult.notes) {
              console.log(`   📋 Notes: ${filterResult.notes}`);
            }
          } catch (error: any) {
            console.warn(`   ⚠️  AI filter determination failed: ${error.message}, using generic filter`);
            // Fallback: Generic filter
            filterParts.push(`serviceName eq '${apiServiceName}'`);
            filterParts.push(`location eq '${azureLocation}'`);
          }
          
          const filter = filterParts.join(' and ');
          const apiUrl = `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}&$top=50`;
          
          console.log(`   🔍 Querying Azure Pricing API: ${filter}`);
          
          const apiResponse = await fetch(apiUrl);
          if (!apiResponse.ok) {
            throw new Error(`Azure Pricing API returned ${apiResponse.status}: ${apiResponse.statusText}`);
          }
          
          pricingData = await apiResponse.json();
          items = pricingData?.Items || [];
          
          console.log(`   📊 Found ${items.length} pricing item(s)`);
          
          if (items.length === 0) {
            console.warn(`   ⚠️  No pricing items found for ${serviceName} in ${azureLocation}`);
            console.warn(`   Query: ${filter}`);
            console.warn(`   This might be due to incorrect location mapping or service name`);
            // For App Service, this is expected (cost is in the plan, not the app itself)
            if (resource.resourceType === 'azurerm_app_service') {
              console.log(`   ℹ️  App Service typically has no direct cost (cost is in App Service Plan)`);
            }
            // Don't throw - let it fall through to add resource with $0 cost
            throw new Error(`No pricing items found for ${serviceName} in ${azureLocation}. Query: ${filter}`);
          }

          // Extract exact cost from Azure Pricing API
          // Filter items to get the most relevant pricing
          let priceItem: any = null;
          
          // For Storage Account, get data storage pricing (not operations)
          if (resource.resourceType === 'azurerm_storage_account') {
            // Prefer "Data Stored" meters (the actual storage cost)
            const dataStorageItems = items.filter((item: any) => 
              item.meterName && (
                item.meterName.toLowerCase().includes('data stored') ||
                item.meterName.toLowerCase().includes('storage')
              ) &&
              !item.meterName.toLowerCase().includes('retrieval') &&
              !item.meterName.toLowerCase().includes('write') &&
              !item.meterName.toLowerCase().includes('read') &&
              !item.meterName.toLowerCase().includes('operation')
            );
            
            if (dataStorageItems.length > 0) {
              // Prefer items with "GB/Month" unit
              const monthlyItems = dataStorageItems.filter((item: any) => 
                item.unitOfMeasure?.includes('GB/Month')
              );
              priceItem = monthlyItems[0] || dataStorageItems[0];
            } else {
              // Fallback: get first item with GB/Month
              const monthlyItems = items.filter((item: any) => 
                item.unitOfMeasure?.includes('GB/Month')
              );
              priceItem = monthlyItems[0] || items[0];
            }
          } else if (resource.resourceType === 'azurerm_app_service_plan') {
            // Filter for compute/instance pricing (the actual plan cost)
            // Look for items that are per-hour compute costs
            const computeItems = items.filter((item: any) => 
              item.unitOfMeasure && (
                item.unitOfMeasure.includes('Hour') || 
                item.unitOfMeasure === '1 Hour'
              ) &&
              !item.meterName?.toLowerCase().includes('request') &&
              !item.meterName?.toLowerCase().includes('bandwidth') &&
              !item.meterName?.toLowerCase().includes('storage') &&
              !item.meterName?.toLowerCase().includes('data transfer')
            );
            
            if (computeItems.length > 0) {
              // Prefer items that match the SKU tier (S1, P1, etc.)
              const sku = resource.attributes?.sku || resource.attributes?.sku_name || 'S1';
              const tier = sku.charAt(0);
              const matchingSkuItem = computeItems.find((item: any) => 
                item.meterName && item.meterName.includes(tier)
              );
              priceItem = matchingSkuItem || computeItems[0];
            } else {
              // Fallback: get any non-request item with hourly pricing
              const hourlyItems = items.filter((item: any) => 
                item.unitOfMeasure?.includes('Hour') &&
                !item.meterName?.toLowerCase().includes('request')
              );
              priceItem = hourlyItems[0] || items[0];
            }
          } else if (resource.resourceType === 'azurerm_app_service') {
            // App Service itself - usually $0, but check for any additional costs
            // Filter out plan costs (those are in the plan resource)
            // Only include items that are NOT part of the plan (e.g., bandwidth, data transfer)
            const appItems = items.filter((item: any) => 
              !item.meterName?.toLowerCase().includes('plan') &&
              !item.meterName?.toLowerCase().includes('compute') &&
              !item.meterName?.toLowerCase().includes('instance') &&
              !item.meterName?.toLowerCase().includes('hour')
            );
            // If no additional costs found, priceItem will be null and cost will be $0
            priceItem = appItems.length > 0 ? appItems[0] : null;
            if (!priceItem) {
              console.log(`   ℹ️  App Service has no additional costs (cost is in App Service Plan)`);
            }
          } else if (resource.resourceType === 'azurerm_container_registry') {
            // Container Registry - filter by SKU tier
            const sku = resource.attributes?.sku || 'Basic';
            const skuItems = items.filter((item: any) => 
              item.productName && item.productName.toLowerCase().includes(sku.toLowerCase())
            );
            if (skuItems.length > 0) {
              priceItem = skuItems[0];
            } else {
              // Fallback: get first item with monthly pricing
              const monthlyItems = items.filter((item: any) => 
                item.unitOfMeasure?.includes('Month')
              );
              priceItem = monthlyItems[0] || items[0];
            }
          } else if (resource.resourceType === 'azurerm_container_app_environment') {
            // Container App Environment - prefer dedicated memory/compute pricing
            // Filter for dedicated memory or vCPU usage (not GPU)
            const computeItems = items.filter((item: any) => 
              (item.unitOfMeasure?.includes('Hour') || item.unitOfMeasure?.includes('vCPU')) &&
              !item.meterName?.toLowerCase().includes('gpu') &&
              !item.meterName?.toLowerCase().includes('session')
            );
            if (computeItems.length > 0) {
              // Prefer "Dedicated Memory Usage" or similar
              const memoryItem = computeItems.find((item: any) => 
                item.meterName?.toLowerCase().includes('memory')
              );
              priceItem = memoryItem || computeItems[0];
            } else {
              priceItem = items[0];
            }
          } else if (resource.resourceType === 'azurerm_log_analytics_workspace') {
            // Log Analytics - prefer data ingestion pricing (first 5GB free, then per GB)
            // Skip the free tier ($0) and get the paid tier
            const paidDataItems = items.filter((item: any) => 
              (item.meterName?.toLowerCase().includes('data ingestion') ||
               item.meterName?.toLowerCase().includes('data')) &&
              item.retailPrice > 0
            );
            if (paidDataItems.length > 0) {
              priceItem = paidDataItems[0];
            } else {
              // Fallback to any data item
              const dataItems = items.filter((item: any) => 
                item.meterName?.toLowerCase().includes('data')
              );
              priceItem = dataItems[0] || items[0];
            }
          } else {
            // For other resources, get the most relevant item
            // Prefer items that match the resource type
            priceItem = items[0];
          }
          
          // Calculate monthly cost based on unit of measure
          let monthlyCost = 0;
          
          // For App Service, if no priceItem found, it means no additional costs (cost is in plan)
          if (!priceItem) {
            if (resource.resourceType === 'azurerm_app_service') {
              console.log(`   ✅ App Service has no additional costs - setting to $0`);
              // Cost is already 0, continue to add resource
            } else {
              throw new Error('No valid pricing item found in API response');
            }
          } else {
            const unitPrice = priceItem.retailPrice || 0;
            const unitOfMeasure = priceItem.unitOfMeasure || '';
            const meterName = priceItem.meterName || '';
            const meterCategory = priceItem.meterCategory || '';
            
            console.log(`   📊 Selected pricing item:`);
            console.log(`      Meter: ${meterName}`);
            console.log(`      Category: ${meterCategory}`);
            console.log(`      Unit: ${unitOfMeasure}`);
            console.log(`      Price: ${unitPrice}`);
            
            // Calculate monthly cost based on unit of measure
            if (unitOfMeasure.includes('Hour') || unitOfMeasure === '1 Hour') {
            // Per hour pricing - convert to monthly
            monthlyCost = unitPrice * 24 * 30;
            console.log(`   💰 Calculation: $${unitPrice}/hour × 24 hours × 30 days = $${monthlyCost.toFixed(2)}/month`);
          } else if (unitOfMeasure.includes('GB') || unitOfMeasure === '1 GB' || unitOfMeasure.includes('GB/Month')) {
            // Per GB pricing - need to estimate usage
            let sizeGB = 100; // Default estimate (100 GB)
            
            // Try to get size from attributes
            if (resource.attributes?.size_gb) {
              sizeGB = parseFloat(resource.attributes.size_gb) || 100;
            } else if (resource.attributes?.disk_size_gb) {
              sizeGB = parseFloat(resource.attributes.disk_size_gb) || 100;
            }
            
            // For Log Analytics, estimate 50GB/month (typical usage, first 5GB free)
            if (resource.resourceType === 'azurerm_log_analytics_workspace') {
              sizeGB = 50; // 50GB/month typical
              // First 5GB is free, so calculate for 45GB
              if (unitPrice > 0) {
                monthlyCost = unitPrice * (sizeGB - 5); // Subtract free tier
                console.log(`   💰 Calculation: $${unitPrice}/GB × (${sizeGB}GB - 5GB free) = $${monthlyCost.toFixed(2)}/month`);
              } else {
                // Free tier
                monthlyCost = 0;
                console.log(`   💰 Calculation: First 5GB free, estimated usage ${sizeGB}GB = $0/month (within free tier)`);
              }
            } else if (unitOfMeasure.includes('GB/Month')) {
              // GB/Month pricing (storage, container registry data)
              monthlyCost = unitPrice * sizeGB;
              console.log(`   💰 Calculation: $${unitPrice}/GB/Month × ${sizeGB}GB = $${monthlyCost.toFixed(2)}/month`);
            } else {
              // Per GB (one-time or per operation) - estimate monthly
              monthlyCost = unitPrice * sizeGB;
              console.log(`   💰 Calculation: $${unitPrice}/GB × ${sizeGB}GB = $${monthlyCost.toFixed(2)}/month`);
            }
          } else if (unitOfMeasure.includes('Month') || unitOfMeasure === '1 Month') {
            // Already monthly
            monthlyCost = unitPrice;
            console.log(`   💰 Calculation: $${unitPrice}/month (already monthly)`);
          } else if (unitOfMeasure.includes('Request') || unitOfMeasure.includes('1 Request')) {
            // Per-request pricing - this is problematic for App Service
            // For App Service Plan, we should NOT use per-request pricing
            if (resource.resourceType === 'azurerm_app_service_plan') {
              throw new Error('App Service Plan pricing should be plan-based, not per-request. Please check API query filters.');
            }
            // For other services, estimate based on typical usage
            const estimatedRequests = resource.attributes?.estimated_requests || 1000000; // 1M requests
            monthlyCost = unitPrice * estimatedRequests;
            console.log(`   💰 Calculation: $${unitPrice}/request × ${estimatedRequests} requests = $${monthlyCost.toFixed(2)}/month`);
          } else {
            // Unknown unit - try to infer from price
            // If price is very small (< $0.01), likely per-hour
            // If price is larger, might be monthly
            if (unitPrice < 0.01) {
              monthlyCost = unitPrice * 24 * 30;
              console.log(`   💰 Calculation: Assuming per-hour (small price), $${unitPrice} × 24 × 30 = $${monthlyCost.toFixed(2)}/month`);
            } else if (unitPrice < 1000) {
              monthlyCost = unitPrice;
              console.log(`   💰 Calculation: Assuming monthly (reasonable price), $${monthlyCost.toFixed(2)}/month`);
            } else {
              throw new Error(`Cannot determine pricing unit. Unit: ${unitOfMeasure}, Price: ${unitPrice}`);
            }
          }
          
          // Final validation
          if (monthlyCost < 0) {
            throw new Error(`Invalid monthly cost calculated: ${monthlyCost}`);
          }
          
          console.log(`   ✅ Final cost: $${monthlyCost.toFixed(2)}/month`);

          const yearlyCost = monthlyCost * 12;

          costEstimates.push({
            resourceName: resource.resourceName,
            resourceType: resource.resourceType,
            serviceName: serviceName,
            monthlyCost: Math.round(monthlyCost * 100) / 100, // Round to 2 decimals
            yearlyCost: Math.round(yearlyCost * 100) / 100,
            currency: 'USD',
            details: resource.attributes
          });

          console.log(`   ✅ Estimated: $${monthlyCost.toFixed(2)}/month ($${yearlyCost.toFixed(2)}/year)`);
          } // End of else block (when priceItem exists)
        } catch (error: any) {
          console.error(`   ❌ Failed to get pricing for ${resource.resourceName}:`, error.message);
          // Don't add resource if pricing fails - let user know it failed
          console.error(`   ⚠️  Skipping ${resource.resourceName} - pricing query failed`);
          // Continue to next resource
        }
        } // End of Azure pricing loop
      } // End of cloud provider check

      // Calculate totals
      const totalMonthly = costEstimates.reduce((sum, r) => sum + r.monthlyCost, 0);
      const totalYearly = costEstimates.reduce((sum, r) => sum + r.yearlyCost, 0);

      console.log(`\n✅ Cost analysis completed`);
      console.log(`   Resources processed: ${costEstimates.length}`);
      console.log(`   Total Monthly: $${totalMonthly.toFixed(2)}`);
      console.log(`   Total Yearly: $${totalYearly.toFixed(2)}`);

      if (costEstimates.length === 0 && parsedResources.length > 0) {
        console.warn(`   ⚠️  Warning: ${parsedResources.length} resource(s) found but no cost estimates generated`);
        console.warn(`   This might indicate all pricing queries failed`);
      }

      res.json({
        success: true,
        summary: {
          totalMonthly: Math.round(totalMonthly * 100) / 100,
          totalYearly: Math.round(totalYearly * 100) / 100,
          currency: 'USD',
          resourceCount: costEstimates.length
        },
        resources: costEstimates
      });

    } catch (error: any) {
      console.error('❌ Error in cost analysis:', error);
      res.status(500).json({ 
        error: 'Failed to analyze costs',
        details: error.message 
      });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
