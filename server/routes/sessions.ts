import type { Express } from "express";
import { storage } from "../storage";
import { insertSessionSchema, type InsertSession } from "@shared/schema";
import { openaiService, type ChatMessage } from "../openai-service";
import { optionalAuth, type AuthenticatedRequest } from "../middleware/auth";
import { validateRequest } from "../middleware/validate";
import { sessionIdParams } from "@shared/api-contracts/common";
import { updateSessionBody, resetSessionBody, chatBody, systemMessageBody } from "@shared/api-contracts/sessions";

/**
 * Session management routes
 */
export function registerSessionRoutes(app: Express): void {
  // Create a new session
  app.post("/api/sessions", optionalAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const session = await storage.createSession({
        userId: req.userId || null
      });
      res.json(session);
    } catch (error) {
      console.error('Error creating session:', error);
      res.status(500).json({ error: 'Failed to create session' });
    }
  });

  // Get session
  app.get("/api/sessions/:id", optionalAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const session = await storage.getSession(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      
      // If session has a user, deny access to any different user (including unauthenticated)
      if (!session.userId || session.userId !== req.userId) {
        console.warn(`[SECURITY] Session access denied: sessionId=${req.params.id} sessionOwner=${session.userId} requesterId=${req.userId ?? 'anonymous'} ip=${req.ip}`);
        return res.status(403).json({ error: 'Access denied to this session' });
      }
      
      // Fetch files and attach them as terraformFiles to satisfy MigrateOps frontend expectation
      const files = await storage.getFilesBySession(req.params.id);
      const sessionWithFiles = {
        ...session,
        terraformFiles: files.map(f => ({ path: f.fileName, content: f.content }))
      };
      
      res.json(sessionWithFiles);
    } catch (error) {
      console.error('Error getting session:', error);
      res.status(500).json({ error: 'Failed to get session' });
    }
  });

  // Update session
  app.patch("/api/sessions/:id", optionalAuth, validateRequest({ params: sessionIdParams, body: updateSessionBody }), async (req: AuthenticatedRequest, res) => {
    try {
      const session = await storage.getSession(req.params.id);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (!session.userId || session.userId !== req.userId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const parsed = insertSessionSchema.partial().parse(req.body);
      
      // Workflow gating: advance to backend_configuration after module approach is selected
      if (parsed.moduleApproach && !parsed.workflowStep) {
        parsed.workflowStep = 'backend_configuration';
      }
      
      const updatedSession = await storage.updateSession(req.params.id, parsed);

      // Sync terraformFiles to files table if provided (used by MigrateOps CodeEditor).
      // Upsert by file name — do NOT delete all files first. A partial list (e.g. one edited file
      // while React state was stale) would otherwise wipe main.tf, variables.tf, etc.
      const reqBody = req.body as any;
      if (reqBody.terraformFiles && Array.isArray(reqBody.terraformFiles)) {
        try {
          console.log(`[SYNC] Upserting ${reqBody.terraformFiles.length} terraform file(s) for session ${req.params.id}`);
          const existing = await storage.getFilesBySession(req.params.id);
          const byName = new Map(existing.map((f) => [f.fileName, f]));
          for (const f of reqBody.terraformFiles) {
            const fileName = f.path || f.fileName || 'unknown.tf';
            const content = f.content ?? '';
            const prev = byName.get(fileName);
            if (prev) {
              await storage.updateFile(prev.id, content);
            } else {
              const created = await storage.createFile({
                sessionId: req.params.id,
                fileName,
                content,
              });
              byName.set(fileName, created);
            }
          }
        } catch (syncError) {
          console.error('[SYNC] Error syncing terraformFiles to files table:', syncError);
        }
      }

      const filesAfter = await storage.getFilesBySession(req.params.id);
      res.json({
        ...updatedSession,
        terraformFiles: filesAfter.map((f) => ({ path: f.fileName, content: f.content })),
      });
    } catch (error) {
      console.error('Error updating session:', error);
      res.status(500).json({ error: 'Failed to update session' });
    }
  });

  // Reset/Refresh session - Clear files and optionally reset state
  app.post("/api/sessions/:id/reset", optionalAuth, validateRequest({ params: sessionIdParams, body: resetSessionBody }), async (req: AuthenticatedRequest, res) => {
    try {
      const sessionId = req.params.id;
      const { clearFiles = true, resetState = false, keepProvider = true } = req.body || {};
      
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!session.userId || session.userId !== req.userId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      console.log(`\n🔄 Resetting session ${sessionId}...`);
      // ... (rest of reset logic stays same)

      console.log(`   Clear files: ${clearFiles}`);
      console.log(`   Reset state: ${resetState}`);
      console.log(`   Keep provider: ${keepProvider}`);

      let filesCleared = 0;
      if (clearFiles) {
        const filesBefore = await storage.getFilesBySession(sessionId);
        filesCleared = filesBefore.length;
        await storage.deleteFilesBySession(sessionId);
        console.log(`   ✅ Cleared ${filesCleared} file(s) from session storage`);
      }

      const updates: Partial<InsertSession> = {};
      if (resetState) {
        updates.currentStep = '1';
        updates.workflowStep = undefined;
        console.log(`   ✅ Reset session state to step 1`);
      }

      if (!keepProvider && resetState) {
        updates.provider = undefined;
        updates.repositoryName = undefined;
        console.log(`   ✅ Cleared provider and repository`);
      }

      if (Object.keys(updates).length > 0) {
        await storage.updateSession(sessionId, updates);
      }

      const updatedSession = await storage.getSession(sessionId);

      console.log(`   ✅ Session reset complete`);
      console.log(`   Files in session: ${(await storage.getFilesBySession(sessionId)).length}`);

      res.json({
        success: true,
        message: `Session reset successfully. ${filesCleared} file(s) cleared.`,
        filesCleared,
        stateReset: resetState,
        session: updatedSession
      });
    } catch (error: any) {
      console.error('Error resetting session:', error);
      res.status(500).json({ 
        error: 'Failed to reset session',
        details: error.message 
      });
    }
  });

  // Get messages for a session
  app.get("/api/sessions/:id/messages", optionalAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const session = await storage.getSession(req.params.id);
      if (!session?.userId || session.userId !== req.userId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const messages = await storage.getMessagesBySession(req.params.id);
      res.json(messages);
    } catch (error) {
      console.error('Error getting messages:', error);
      res.status(500).json({ error: 'Failed to get messages' });
    }
  });

  // Debug endpoint: Get all files for a session
  app.get("/api/sessions/:id/files-debug", optionalAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const sessionId = req.params.id;
      const session = await storage.getSession(sessionId);
      if (!session?.userId || session.userId !== req.userId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const files = await storage.getFilesBySession(sessionId);
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
  app.post("/api/sessions/:id/messages/system", optionalAuth, validateRequest({ params: sessionIdParams, body: systemMessageBody }), async (req: AuthenticatedRequest, res) => {
    try {
      const { message } = req.body;
      const sessionId = req.params.id;
      
      const session = await storage.getSession(sessionId);
      if (!session?.userId || session.userId !== req.userId) {
        return res.status(403).json({ error: 'Access denied' });
      }

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

  // Send a chat message
  app.post("/api/sessions/:id/chat", optionalAuth, validateRequest({ params: sessionIdParams, body: chatBody }), async (req: AuthenticatedRequest, res) => {
    try {
      const { message } = req.body;
      const sessionId = req.params.id;

      // Get session
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!session.userId || session.userId !== req.userId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Save user message
      const userMessage = await storage.createMessage({
        sessionId,
        type: 'user',
        content: message,
      });
      // ... (rest of chat logic stays same)


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
      // Detect workflow type
      const hasArchMeAnalysis = !!(session as any).archMeAnalysis;
      const moduleTag = session.activeModule;
      const isArchMeWorkflow = moduleTag === 'archme' ||
                               hasArchMeAnalysis ||
                               (!session.cloudProvider && 
                                !session.moduleApproach &&
                                (session.currentStep === '1' || !session.currentStep || session.currentStep === '0'));
      const isAutomationWorkflow = moduleTag === 'automation' ||
                                   (!isArchMeWorkflow &&
                                    !session.cloudProvider && 
                                    !session.moduleApproach && 
                                    (session.currentStep === '1' || session.currentStep === '2' || session.currentStep === '3' || session.currentStep === '4'));
      
      let contextPrompt: string;
      if (isArchMeWorkflow) {
        contextPrompt = `You are an AI DevOps assistant focused exclusively on the ArchMe architecture diagram workflow. The user is providing high-level requirements that will be transformed directly into a diagram.

IMPORTANT CONTEXT:
- Reject prompts about Terraform, automation scripts, Dockerfiles, or ScoreMe.
- Do not output exhaustive lists of components, relationships, or data flows.
- Respond briefly with a generic acknowledgement (e.g., "Architecture noted. Generating diagram...") so the UI can immediately display the diagram.

Your role:
1. Keep conversational responses minimal and architecture-focused.
2. Avoid describing each service and relationship; just confirm and proceed.
3. Guide users back to architectural intent if they mention other modules.
4. Prompt the user to approve the diagram before generating code.`;
      } else if (isAutomationWorkflow) {
        contextPrompt = `You are an AI DevOps assistant helping users create automation scripts. The user is at step ${session.currentStep} of the Automation Script workflow.

IMPORTANT CONTEXT:
- This is about creating automation scripts (Python, PowerShell, Shell, Bash)
- This is NOT about Terraform infrastructure code
- This is NOT about Terraform automation or workflows
- Even if the repository contains Terraform files, the user wants to create a NEW automation script
- The automation script will be added as a new file alongside existing files (like Terraform)
- Focus on general automation, CI/CD, DevOps tasks, data processing, etc.

Your role:
1. Help users describe what they want to automate
2. Clarify automation requirements and use cases
3. Guide users on scripting best practices
4. Keep responses focused on automation scripts, NOT Terraform

DO NOT:
- Suggest Terraform-related automation (terraform init, plan, apply, etc.)
- Reference Terraform files in the repository
- Provide Terraform code examples
- Focus on infrastructure as code

DO:
- Help clarify automation requirements
- Suggest automation patterns and best practices
- Guide users on describing their automation needs
- Focus on scripting languages and automation tools`;
      } else {
        contextPrompt = `You are an AI DevOps assistant. The user is at step ${session.currentStep} of the Terraform workflow.`;
      }
      
      // Add detected repository information if available (only for Terraform workflows)
      if (!isAutomationWorkflow && !isArchMeWorkflow && sessionContext.isExistingRepo && sessionContext.terraformFiles.length > 0) {
        const moduleTypeText = sessionContext.detectedModuleType === 'child' ? 'child module' :
                              sessionContext.detectedModuleType === 'root' ? 'root module' :
                              'Terraform configuration';
        contextPrompt += `\n\nDETECTED REPOSITORY: This is an existing ${moduleTypeText}`;
        if (sessionContext.detectedCloudProvider) {
          contextPrompt += ` for ${sessionContext.detectedCloudProvider.toUpperCase()}`;
        }
        contextPrompt += ` with ${sessionContext.terraformFiles.length} Terraform files.`;
      } else if (isAutomationWorkflow && session.provider && session.repositoryName) {
        contextPrompt += `\n\nREPOSITORY: User has selected ${session.provider === 'github' ? 'GitHub' : 'Azure Repo'} repository "${session.repositoryName}". The repository may contain existing files (like Terraform), but IGNORE those files. The user wants to create a NEW automation script that will be added as a new file to this repository. Do NOT suggest Terraform-related automation tasks.`;
      }
      
      if (isArchMeWorkflow) {
        // ArchMe workflow - no step-based prompts, just architecture-focused guidance
        contextPrompt += `\n\nARCHITECTURE DIAGRAM WORKFLOW:
- User describes architecture requirements in natural language
- System analyzes requirements and extracts components, relationships, and data flows
- System generates visual Mermaid diagram
- Focus on helping users describe their architecture clearly and accurately`;
      } else if (session.currentStep === '1') {
        if (isAutomationWorkflow) {
          contextPrompt += `\n\nStep 1: Language Selection - User is selecting a scripting language (Python, PowerShell, Shell, or Bash) for automation. Help them choose if needed, but keep it brief. Focus on automation scripts, NOT Terraform.`;
        } else {
          contextPrompt += `\n\nStep 1: Provider Selection - Help user choose between GitHub or Azure DevOps. Keep it brief.`;
        }
      } else if (session.currentStep === '2') {
        if (isAutomationWorkflow) {
          contextPrompt += `\n\nStep 2: Repository Selection - Help user select a repository (GitHub or Azure Repo) where the automation script will be added. The repository may already contain other files (like Terraform). Keep it brief.`;
        } else {
          contextPrompt += `\n\nStep 2: Repository Selection - Help user select an existing repository or create a new one. Keep it brief.`;
        }
      } else if (session.currentStep === '3') {
        if (isAutomationWorkflow) {
          contextPrompt += `\n\nStep 3: Automation Description - User will describe what they want to automate. Help them clarify their automation needs. 

CRITICAL: Focus on general automation scripts (data processing, file operations, API calls, CI/CD tasks, etc.), NOT Terraform automation. Even if the repository has Terraform files, the user wants a general automation script, not Terraform workflow automation. 

DO NOT suggest:
- Terraform init/plan/apply/destroy automation
- Terraform state management
- Terraform validation workflows

DO suggest:
- General automation tasks (data processing, file manipulation, API integration, etc.)
- CI/CD pipeline scripts
- DevOps automation tasks
- System administration scripts

Keep responses brief and automation-focused.`;
        } else {
          contextPrompt += `\n\nStep 3: Cloud Provider Selection - Help user choose Azure, AWS, or GCP. Keep it brief.`;
        }
      } else if (session.currentStep === '4') {
        if (isAutomationWorkflow) {
          contextPrompt += `\n\nStep 4: Review & Push - User is reviewing the generated automation script. Answer questions about the script, help with modifications, or assist with pushing to repository. Focus on automation scripts, NOT Terraform. Keep it brief.`;
        } else {
          contextPrompt += `\n\nStep 4: Module Approach Selection - Help user choose between child module, standalone root module, or aggregated root module. Keep it brief.`;
        }
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
        
        step5Prompt += `\n\nCRITICAL INSTRUCTIONS FOR STEP 5:
1. When user requests resources (e.g., "create AKS", "add storage account", "create container app"), respond BRIEFLY:
   - Acknowledge: "I'll generate the Terraform code for [resource type]..."
   - Keep it to 1-2 sentences maximum
   - DO NOT provide code examples, explanations, or detailed breakdowns
   - DO NOT show Terraform code blocks in your response
   - The actual code generation happens via the generate-terraform API endpoint

2. Example good response: "I'll generate the Terraform code for your container app environment and container app. The code will be added to your existing files."

3. Example bad response (DO NOT DO THIS):
   - Long explanations about what resources are needed
   - Code examples in markdown blocks
   - Step-by-step breakdowns
   - Detailed configuration explanations

4. If user asks questions about Terraform concepts, you can answer those, but keep it brief.

5. If user requests resources, your response should be action-oriented and brief, not educational.`;
        contextPrompt += step5Prompt;
      } else if (session.currentStep === '6') {
        contextPrompt += `\n\nStep 6: Review & Commit - User is reviewing generated Terraform files. Answer questions about the code or configurations. Be concise and helpful.`;
      }

      // Check if message is requesting Terraform resource generation
      const isResourceGenerationRequest = (msg: string): boolean => {
        const lowerMsg = msg.toLowerCase();
        const generationKeywords = [
          'create', 'generate', 'add', 'build', 'setup', 'deploy',
          'terraform', 'infrastructure', 'resource', 'provision'
        ];
        const resourceKeywords = [
          'storage', 'container', 'registry', 'function', 'app', 'vm',
          'database', 'network', 'vnet', 'aks', 'logic app', 'logicapp', 'key vault',
          'service bus', 'event hub', 'cosmos', 'sql', 'postgres', 'mysql'
        ];
        
        const hasGenerationKeyword = generationKeywords.some(kw => lowerMsg.includes(kw));
        const hasResourceKeyword = resourceKeywords.some(kw => lowerMsg.includes(kw));
        const hasAzureKeyword = lowerMsg.includes('azure') || lowerMsg.includes('azurerm');
        
        return hasGenerationKeyword && (hasResourceKeyword || hasAzureKeyword);
      };

      // If this is a resource generation request and session is ready
      const shouldAutoGenerate = !isAutomationWorkflow &&
                                 !isArchMeWorkflow &&
                                 isResourceGenerationRequest(message) && 
                                 session.cloudProvider && 
                                 session.moduleApproach &&
                                 (session.currentStep === '5' || session.currentStep === '6' || parseInt(session.currentStep || '0') >= 5);
      
      // Get AI response with context
      const aiResponse = await openaiService.chatWithContext(contextPrompt, chatHistory);

      // Clean AI response - for generation requests, always use a short action message.
      // This prevents verbose plan/explanation text from appearing in chat.
      let cleanedResponse = aiResponse;
      if (shouldAutoGenerate || isResourceGenerationRequest(message)) {
        cleanedResponse = "Generating your infrastructure code...";
      }

      // Save AI message
      const aiMessage = await storage.createMessage({
        sessionId,
        type: 'ai',
        content: cleanedResponse,
      });

      // If this is a generation request, trigger generation in the background
      if (shouldAutoGenerate) {
        console.log('\n🤖 [CHAT] Detected resource generation request, triggering auto-generation...');
        
        // Trigger generation asynchronously (don't wait for it)
        (async () => {
          try {
            const existingFiles = await storage.getFilesBySession(sessionId);
            const filesForGeneration = existingFiles.map(f => ({
              path: f.fileName,
              content: f.content
            }));

            const backendConfig = session.hasBackend === 'true' ? {
              hasBackend: true,
              backendType: session.backendType || undefined,
              storageAccount: session.backendStorageAccount || undefined,
              resourceGroup: session.backendResourceGroup || undefined,
              container: session.backendContainer || undefined,
              stateKey: session.backendStateKey || undefined,
              location: session.backendLocation || undefined,
            } : undefined;

            const result = await openaiService.generateTerraform(
              message,
              session.cloudProvider!,
              session.moduleApproach!,
              backendConfig,
              filesForGeneration.length > 0 ? filesForGeneration : undefined
            );

            if (result.files && result.files.length > 0) {
              const allSessionFiles = await storage.getFilesBySession(sessionId);
              
              for (const file of result.files) {
                const fileName = file.path.split('/').pop() || file.path;
                if (['backend.tf', 'provider.tf', 'terraform.tf'].includes(fileName)) {
                  continue;
                }

                const existingFile = allSessionFiles.find(f => f.fileName === fileName);
                
                if (existingFile) {
                  await storage.updateFile(existingFile.id, file.content);
                } else {
                  await storage.createFile({
                    sessionId,
                    fileName,
                    content: file.content,
                  });
                }
              }

              await storage.createMessage({
                sessionId,
                type: 'ai',
                content: `✅ Terraform code has been generated and saved. ${result.files.length} file(s) updated.`,
              });
            }
          } catch (error: any) {
            console.error('❌ [CHAT] Auto-generation failed:', error);
            await storage.createMessage({
              sessionId,
              type: 'ai',
              content: `❌ Failed to generate Terraform code: ${error.message || 'Unknown error'}. Please try again or check the console for details.`,
            });
          }
        })();
      }

      res.json({ userMessage, aiMessage, autoGenerationTriggered: shouldAutoGenerate });
    } catch (error: any) {
      console.error('❌ Error in chat endpoint:', error);
      res.status(500).json({ 
        error: 'Failed to process chat message',
        details: error?.message || 'Unknown error occurred',
        type: error?.constructor?.name || 'Error'
      });
    }
  });
}

