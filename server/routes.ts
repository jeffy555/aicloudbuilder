import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { mcpClient, type MCPProvider } from "./mcp-client";
import { openaiService, type ChatMessage } from "./openai-service";
import { insertMessageSchema, insertGeneratedFileSchema, insertSessionSchema, type Repository } from "@shared/schema";

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

  // Send a chat message
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

      // Get conversation history
      const messages = await storage.getMessagesBySession(sessionId);
      const chatHistory: ChatMessage[] = messages.map(m => ({
        role: m.type === 'user' ? 'user' : 'assistant',
        content: m.content
      }));

      // Get AI response
      const aiResponse = await openaiService.chat(chatHistory);

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
    try {
      const provider = req.params.provider as MCPProvider;
      const { name, description } = req.body;
      
      // Validate provider credentials
      if (provider === 'azure' && (!process.env.AZURE_DEVOPS_ORG || !process.env.AZURE_DEVOPS_PAT || !process.env.AZURE_DEVOPS_PROJECT)) {
        return res.status(400).json({ error: 'Azure DevOps credentials not configured. Please set AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT, and AZURE_DEVOPS_PROJECT environment variables.' });
      }
      if (provider === 'github' && (!process.env.GITHUB_TOKEN || !process.env.GITHUB_OWNER)) {
        return res.status(400).json({ error: 'GitHub credentials not configured. Please set GITHUB_TOKEN and GITHUB_OWNER environment variables.' });
      }

      const repo = await mcpClient.createRepository(provider, name, description);
      res.json(repo);
    } catch (error) {
      console.error('Error creating repository:', error);
      res.status(500).json({ error: 'Failed to create repository' });
    }
  });

  // Generate Terraform files
  app.post("/api/sessions/:id/generate-terraform", async (req, res) => {
    try {
      const { description } = req.body;
      const sessionId = req.params.id;

      // Generate Terraform files
      const files = await openaiService.generateTerraform(description);

      // Delete existing files for this session
      await storage.deleteFilesBySession(sessionId);

      // Save generated files
      const savedFiles = await Promise.all([
        storage.createFile({
          sessionId,
          fileName: 'main.tf',
          content: files.mainTf,
        }),
        storage.createFile({
          sessionId,
          fileName: 'variables.tf',
          content: files.variablesTf,
        }),
        storage.createFile({
          sessionId,
          fileName: 'terraform.tfvars',
          content: files.tfvars,
        }),
      ]);

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

  const httpServer = createServer(app);

  return httpServer;
}
