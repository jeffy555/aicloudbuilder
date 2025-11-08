import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { mcpClient, type MCPProvider } from "./mcp-client";
import { openaiService, type ChatMessage } from "./openai-service";
import { insertMessageSchema, insertGeneratedFileSchema, insertSessionSchema, type Repository, type InsertSession } from "@shared/schema";
import { analyzeTerraformFiles } from "./terraform-parser";

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
      const sessionContext = {
        isExistingRepo: session.isExistingRepo === 'true',
        detectedCloudProvider: session.detectedCloudProvider,
        detectedModuleType: session.detectedModuleType,
        terraformFiles: session.detectedTerraformFiles ? (session.detectedTerraformFiles as unknown as string[]) : [],
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
    } catch (error) {
      console.error('Error in chat:', error);
      res.status(500).json({ error: 'Failed to process chat message' });
    }
  });

  // List repositories
  app.get("/api/repositories/:provider", async (req, res) => {
    try {
      const provider = req.params.provider as MCPProvider;
      
      // Validate provider credentials
      if (provider === 'azure' && (!process.env.AZURE_DEVOPS_ORG || !process.env.AZURE_DEVOPS_PAT || !process.env.AZURE_DEVOPS_PROJECT)) {
        return res.status(400).json({ error: 'Azure DevOps credentials not configured. Please set AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT, and AZURE_DEVOPS_PROJECT environment variables.' });
      }
      if (provider === 'github' && (!process.env.GITHUB_TOKEN || !process.env.GITHUB_OWNER)) {
        return res.status(400).json({ error: 'GitHub credentials not configured. Please set GITHUB_TOKEN and GITHUB_OWNER environment variables.' });
      }
      
      const repos = await mcpClient.listRepositories(provider);
      
      // Transform to common format
      const formatted: Repository[] = repos.map((repo: any, index: number) => ({
        id: repo.id || `${index}`,
        name: repo.name || repo.Name || 'Unknown',
        lastUpdated: repo.updated_at || repo.lastUpdateTime || '',
        branch: repo.default_branch || repo.defaultBranch || 'main'
      }));

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

      const analysis = analyzeTerraformFiles(files);

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

      const result = {
        isExisting: files.length > 0,
        cloudProvider: analysis.cloudProvider,
        moduleType: analysis.moduleType,
        terraformFiles: files.map(f => f.path),
        hasResources: analysis.hasResources,
        hasModules: analysis.hasModules,
        providerBlocks: analysis.providerBlocks,
        backend: analysis.backend,
      };

      res.json(result);
    } catch (error: any) {
      console.error('Error scanning repository:', error);
      res.status(500).json({ error: 'Failed to scan repository' });
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
        // Use provided config or generate sensible defaults
        const defaults = {
          storageAccount: backendConfig?.storageAccount || `tfstate${Date.now().toString().slice(-8)}`,
          resourceGroup: backendConfig?.resourceGroup || 'terraform-state-rg',
          container: backendConfig?.container || 'tfstate',
          location: backendConfig?.location || 'eastus',
          stateKey: backendConfig?.stateKey || 'terraform.tfstate'
        };

        // Update session with backend configuration
        await storage.updateSession(sessionId, {
          hasBackend: 'true',
          backendType: 'azurerm',
          backendStorageAccount: defaults.storageAccount,
          backendResourceGroup: defaults.resourceGroup,
          backendContainer: defaults.container,
          backendLocation: defaults.location,
          backendStateKey: defaults.stateKey,
          backendValidated: 'pending',
          workflowStep: 'terraform_generation'
        });

        return res.json({
          status: 'configured',
          message: 'Backend configuration set. Resources will be created during Terraform apply.',
          details: defaults
        });
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

      // Prepare backend configuration
      const backendConfig = session.hasBackend === 'true' ? {
        hasBackend: true,
        backendType: session.backendType || undefined,
        storageAccount: session.backendStorageAccount || undefined,
        resourceGroup: session.backendResourceGroup || undefined,
        container: session.backendContainer || undefined,
        stateKey: session.backendStateKey || undefined,
        location: session.backendLocation || undefined,
      } : { hasBackend: false };

      // Generate Terraform files with context
      const result = await openaiService.generateTerraform(
        description, 
        session.cloudProvider, 
        session.moduleApproach,
        backendConfig
      );

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

      // Delete existing files for this session
      await storage.deleteFilesBySession(sessionId);

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
      const allFiles = [
        ...result.files,
        { path: 'README.md', content: readmeContent }
      ];

      const savedFiles = await Promise.all(
        allFiles.map(file => 
          storage.createFile({
            sessionId,
            fileName: file.path,
            content: file.content,
          })
        )
      );

      // Update session to Review step (Step 6)
      await storage.updateSession(sessionId, { currentStep: '6' });

      res.json(savedFiles);
    } catch (error) {
      console.error('Error generating Terraform:', error);
      res.status(500).json({ error: 'Failed to generate Terraform files' });
    }
  });

  // Get generated files
  app.get("/api/sessions/:id/files", async (req, res) => {
    try {
      const files = await storage.getFilesBySession(req.params.id);
      res.json(files);
    } catch (error) {
      console.error('Error getting files:', error);
      res.status(500).json({ error: 'Failed to get files' });
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

  // Run Checkov security scan on generated files
  app.post("/api/sessions/:id/scan", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const files = await storage.getFilesBySession(sessionId);
      
      if (files.length === 0) {
        return res.status(400).json({ error: 'No files to scan' });
      }

      // Import required modules
      const fs = await import('fs/promises');
      const path = await import('path');
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);
      const os = await import('os');

      // Create a temporary directory for scanning
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'checkov-'));
      
      try {
        // Write all Terraform files to temp directory
        for (const file of files) {
          const filePath = path.join(tempDir, file.fileName);
          const fileDir = path.dirname(filePath);
          
          // Create directory if it doesn't exist
          await fs.mkdir(fileDir, { recursive: true });
          await fs.writeFile(filePath, file.content, 'utf-8');
        }

        // Run Checkov with JSON output
        let scanResult;
        try {
          const { stdout, stderr } = await execFileAsync('checkov', [
            '-d', tempDir,
            '--framework', 'terraform',
            '--output', 'json',
            '--compact',
            '--quiet'
          ], { maxBuffer: 1024 * 1024 * 10 }); // 10MB buffer

          scanResult = JSON.parse(stdout);
        } catch (execError: any) {
          // Checkov exits with non-zero code if there are failures
          // But still outputs JSON, so we can parse it
          if (execError.stdout) {
            scanResult = JSON.parse(execError.stdout);
          } else {
            throw execError;
          }
        }

        // Parse results
        const summary = scanResult.summary || {};
        const passed = summary.passed || 0;
        const failed = summary.failed || 0;
        const skipped = summary.skipped || 0;
        const total = passed + failed + skipped;
        const passPercentage = total > 0 ? Math.round((passed / total) * 100) : 0;

        // Get detailed check results
        const checks = scanResult.results?.failed_checks || [];
        const passedChecks = scanResult.results?.passed_checks || [];

        res.json({
          success: true,
          summary: {
            passed,
            failed,
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
        });
      } finally {
        // Clean up temp directory
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    } catch (error: any) {
      console.error('Error running Checkov scan:', error);
      res.status(500).json({ 
        error: 'Failed to run security scan',
        details: error.message 
      });
    }
  });

  // Commit files to repository
  app.post("/api/sessions/:id/commit", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const session = await storage.getSession(sessionId);
      
      if (!session || !session.provider || !session.repositoryName) {
        return res.status(400).json({ error: 'Session not properly configured' });
      }

      // Get files
      const files = await storage.getFilesBySession(sessionId);
      
      // Generate commit message
      const commitMessage = await openaiService.generateCommitMessage(
        files.map(f => ({ name: f.fileName, content: f.content }))
      );

      // Commit via MCP
      const result = await mcpClient.commitFiles(
        session.provider as MCPProvider,
        session.repositoryName,
        files.map(f => ({ path: f.fileName, content: f.content })),
        commitMessage
      );

      res.json({ success: true, commitMessage, result });
    } catch (error: any) {
      console.error('Error committing files:', error);
      const errorMessage = error?.message || 'Failed to commit files';
      res.status(500).json({ error: errorMessage });
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

  const httpServer = createServer(app);

  return httpServer;
}
