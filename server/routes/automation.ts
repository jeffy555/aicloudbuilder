import type { Express } from "express";
import { storage } from "../storage";
import { openaiService } from "../openai-service";
import { mcpClient, type MCPProvider } from "../mcp-client";
import { optionalAuth, type AuthenticatedRequest } from "../middleware/auth";
import { validateRequest } from "../middleware/validate";
import { sessionIdParams } from "@shared/api-contracts/common";
import { generateAutomationBody, commitAutomationBody } from "@shared/api-contracts/automation";

/**
 * Automation Scripts routes
 */
export function registerAutomationRoutes(app: Express): void {
  // Generate automation script
  app.post("/api/sessions/:id/generate-automation", optionalAuth, validateRequest({ params: sessionIdParams, body: generateAutomationBody }), async (req: AuthenticatedRequest, res) => {
    try {
      const { language, prompt } = req.body;
      const sessionId = req.params.id;

      if (!language || !prompt) {
        return res.status(400).json({ 
          error: 'Missing required fields',
          details: 'Both language and prompt are required'
        });
      }

      if (!['python', 'powershell', 'shell', 'bash'].includes(language)) {
        return res.status(400).json({ 
          error: 'Invalid language',
          details: 'Language must be one of: python, powershell, shell, bash'
        });
      }

      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!session.userId || session.userId !== req.userId) {
        console.warn(`[SECURITY] Automation session access denied: sessionId=${sessionId} sessionOwner=${session.userId} requesterId=${req.userId ?? 'anonymous'} ip=${req.ip}`);
        return res.status(403).json({ error: 'Access denied to this session' });
      }

      console.log(`\n🤖 ========== AUTOMATION SCRIPT GENERATION ==========`);
      console.log(`Session ID: ${sessionId}`);
      console.log(`Language: ${language}`);
      console.log(`Prompt: "${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}"`);

      // Generate automation script
      const result = await openaiService.generateAutomation(language, prompt);

      console.log(`✅ Generated ${result.files.length} file(s)`);

      // Save generated files to session storage
      for (const file of result.files) {
        const existingFiles = await storage.getFilesBySession(sessionId);
        const existingFile = existingFiles.find(f => f.fileName === file.path);

        if (existingFile) {
          await storage.updateFile(existingFile.id, file.content);
          console.log(`   📝 Updated: ${file.path}`);
        } else {
          await storage.createFile({
            sessionId,
            fileName: file.path,
            content: file.content,
          });
          console.log(`   ✨ Created: ${file.path}`);
        }
      }

      // Notify user via system message
      await storage.createMessage({
        sessionId,
        type: 'ai',
        content: `✅ Automation script has been generated successfully! ${result.files.length} file(s) created.`,
      });

      console.log('==========================================\n');

      res.json({
        success: true,
        files: result.files
      });

    } catch (error: any) {
      console.error('❌ Error generating automation script:', error);
      res.status(500).json({ 
        error: 'Failed to generate automation script',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Commit automation files to repository
  app.post("/api/sessions/:id/commit-automation", optionalAuth, validateRequest({ params: sessionIdParams, body: commitAutomationBody }), async (req: AuthenticatedRequest, res) => {
    const sessionId = req.params.id;
    let session: any = null;

    try {
      session = await storage.getSession(sessionId);

      if (!session || !session.provider || !session.repositoryName) {
        return res.status(400).json({ error: 'Session not properly configured' });
      }
      if (!session.userId || session.userId !== req.userId) {
        console.warn(`[SECURITY] Commit-automation session access denied: sessionId=${sessionId} sessionOwner=${session.userId} requesterId=${req.userId ?? 'anonymous'} ip=${req.ip}`);
        return res.status(403).json({ error: 'Access denied to this session' });
      }

      const { message, branch = 'main' } = req.body;

      // Get files from session storage
      console.log(`\n📁 Getting automation files from session storage for commit...`);
      const files = await storage.getFilesBySession(sessionId);
      
      console.log(`✅ Found ${files.length} file(s) in session storage`);
      
      if (files.length === 0) {
        return res.status(400).json({ 
          error: 'No files found to commit',
          details: 'No automation files have been generated for this session yet.'
        });
      }
      
      // Filter to automation script files (Python, PowerShell, Shell, Bash)
      const automationFiles = files.filter(file => {
        const fileName = file.fileName.toLowerCase();
        return fileName.endsWith('.py') || 
               fileName.endsWith('.ps1') || 
               fileName.endsWith('.sh') ||
               fileName.endsWith('.bash');
      });
      
      console.log(`📄 Automation files to commit: ${automationFiles.length}`);
      automationFiles.forEach(f => {
        console.log(`   - ${f.fileName} (${f.content.length} chars)`);
      });
      
      if (automationFiles.length === 0) {
        return res.status(400).json({ 
          error: 'No automation files found to commit',
          details: 'No automation script files (.py, .ps1, .sh, .bash) found in session'
        });
      }
      
      // Generate commit message if not provided
      let commitMessage = message;
      if (!commitMessage) {
        try {
          commitMessage = await openaiService.generateCommitMessage(
            automationFiles.map(f => ({ name: f.fileName, content: f.content }))
          );
        } catch (error: any) {
          console.warn(`⚠️  Failed to generate commit message: ${error.message}`);
          commitMessage = `Add automation scripts: ${automationFiles.map(f => f.fileName).join(', ')}`;
        }
      }

      // Commit via MCP
      const result = await mcpClient.commitFiles(
        session.provider as MCPProvider,
        session.repositoryName,
        automationFiles.map(f => ({ path: f.fileName, content: f.content })),
        commitMessage
      );

      console.log(`✅ Successfully committed ${automationFiles.length} automation file(s) to ${session.provider}/${session.repositoryName}`);
      console.log(`   Commit message: ${commitMessage}`);
      console.log(`   Branch: ${branch}`);

      res.json({
        success: true,
        commitMessage,
        branch,
        filesCommitted: automationFiles.length,
        commitUrl: result.commitUrl || undefined,
      });

    } catch (error: any) {
      console.error('❌ Error committing automation files:', error);
      res.status(500).json({ 
        error: 'Failed to commit automation files',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });
}

