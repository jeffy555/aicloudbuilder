/**
 * Generic commit routes
 * Handles committing files to repositories (shared across modules)
 */

import type { Express } from "express";
import { storage } from "../storage";
import { mcpClient, type MCPProvider } from "../mcp-client";
import { openaiService } from "../openai-service";

/**
 * Register commit routes
 */
export function registerCommitRoutes(app: Express) {
  // Generic commit endpoint (for Terraform files)
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
}

