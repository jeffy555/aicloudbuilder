import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, type ChildProcess } from "child_process";

export type MCPProvider = 'github' | 'azure';

interface MCPClientConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export class MCPClientManager {
  private clients: Map<string, { client: Client; process: ChildProcess }> = new Map();

  private getConfig(provider: MCPProvider): MCPClientConfig {
    if (provider === 'github') {
      return {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN || '',
        }
      };
    } else {
      // Azure DevOps
      return {
        command: 'npx',
        args: [
          '-y',
          '@azure-devops/mcp',
          process.env.AZURE_DEVOPS_ORG || '',
          '-d',
          'repositories'
        ],
        env: {
          AZURE_DEVOPS_AUTH_METHOD: 'pat',
          AZURE_DEVOPS_PAT: process.env.AZURE_DEVOPS_PAT || '',
        }
      };
    }
  }

  async getClient(provider: MCPProvider): Promise<Client> {
    const clientKey = provider;
    
    if (this.clients.has(clientKey)) {
      return this.clients.get(clientKey)!.client;
    }

    const config = this.getConfig(provider);
    const client = new Client({
      name: `ai-devops-${provider}`,
      version: '1.0.0',
    }, {
      capabilities: {}
    });

    const childProcess = spawn(config.command, config.args, {
      env: { ...process.env, ...config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...config.env } as Record<string, string>
    });

    await client.connect(transport);

    this.clients.set(clientKey, { client, process: childProcess });

    return client;
  }

  async callTool(provider: MCPProvider, toolName: string, args: Record<string, any>): Promise<any> {
    const client = await this.getClient(provider);
    
    const result = await client.callTool({
      name: toolName,
      arguments: args
    });

    return result;
  }

  async listRepositories(provider: MCPProvider): Promise<any[]> {
    try {
      if (provider === 'github') {
        const owner = process.env.GITHUB_OWNER || '';
        const result = await this.callTool(provider, 'list_repositories', {
          query: `user:${owner}`,
          minimal_output: true
        });
        // Parse MCP content parts
        if (result.content && Array.isArray(result.content)) {
          const textContent = result.content.find((item: any) => item.type === 'text');
          if (textContent && textContent.text) {
            const parsed = JSON.parse(textContent.text);
            // Handle search results format
            return parsed.items || parsed || [];
          }
        }
        return [];
      } else {
        // Azure DevOps
        const result = await this.callTool(provider, 'git_list_repositories', {
          project: process.env.AZURE_DEVOPS_PROJECT || ''
        });
        // Parse MCP content parts
        if (result.content && Array.isArray(result.content)) {
          const textContent = result.content.find((item: any) => item.type === 'text');
          if (textContent && textContent.text) {
            return JSON.parse(textContent.text);
          }
        }
        return [];
      }
    } catch (error) {
      console.error(`Error listing repositories for ${provider}:`, error);
      throw error;
    }
  }

  async createRepository(provider: MCPProvider, name: string, description?: string): Promise<any> {
    try {
      if (provider === 'github') {
        const result = await this.callTool(provider, 'create_repository', {
          owner: process.env.GITHUB_OWNER || '',
          name,
          description: description || '',
          private: false,
          auto_init: true, // Initialize with README to create main branch
        });
        // Parse MCP content parts
        let repoData = { name };
        if (result.content && Array.isArray(result.content)) {
          const textContent = result.content.find((item: any) => item.type === 'text');
          if (textContent && textContent.text) {
            repoData = JSON.parse(textContent.text);
          }
        }
        
        // Wait for GitHub to finish initializing the repository
        console.log(`Waiting for repository ${name} to be fully initialized...`);
        await this.waitForRepositoryInitialization(provider, name);
        
        return repoData;
      } else {
        // Azure DevOps
        const result = await this.callTool(provider, 'git_create_repository', {
          project: process.env.AZURE_DEVOPS_PROJECT || '',
          name,
        });
        // Parse MCP content parts
        if (result.content && Array.isArray(result.content)) {
          const textContent = result.content.find((item: any) => item.type === 'text');
          if (textContent && textContent.text) {
            return JSON.parse(textContent.text);
          }
        }
        return { name };
      }
    } catch (error) {
      console.error(`Error creating repository for ${provider}:`, error);
      throw error;
    }
  }

  async waitForRepositoryInitialization(provider: MCPProvider, repoName: string): Promise<void> {
    const maxAttempts = 10;
    const delay = 2000; // 2 seconds between checks
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        if (provider === 'github') {
          // Try to get repository info to check if it's initialized
          const result = await this.callTool(provider, 'get_file_contents', {
            owner: process.env.GITHUB_OWNER || '',
            repo: repoName,
            path: 'README.md',
            branch: 'main'
          });
          
          // If we can read README.md, the repo is initialized
          if (result.content && Array.isArray(result.content)) {
            console.log(`Repository ${repoName} is ready!`);
            return;
          }
        }
      } catch (error: any) {
        // Expected to fail until repo is ready
        console.log(`Repository initialization check ${attempt + 1}/${maxAttempts}...`);
      }
      
      if (attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    console.log(`Repository may not be fully initialized, proceeding anyway after ${maxAttempts} checks`);
  }

  async commitFiles(
    provider: MCPProvider,
    repoName: string,
    files: { path: string; content: string }[],
    message: string
  ): Promise<any> {
    const maxRetries = 5;
    const baseDelay = 3000; // 3 seconds
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (provider === 'github') {
          const result = await this.callTool(provider, 'push_files', {
            owner: process.env.GITHUB_OWNER || '',
            repo: repoName,
            files: files.map(f => ({
              path: f.path,
              content: f.content
            })),
            message,
            branch: 'main',
          });
          // Parse MCP content parts
          if (result.content && Array.isArray(result.content)) {
            const textContent = result.content.find((item: any) => item.type === 'text');
            if (textContent && textContent.text) {
              return JSON.parse(textContent.text);
            }
          }
          return { success: true };
        } else {
          // Azure DevOps - commit files to repository
          const result = await this.callTool(provider, 'git_create_push', {
            project: process.env.AZURE_DEVOPS_PROJECT || '',
            repositoryId: repoName,
            changes: files.map(f => ({
              changeType: 'add',
              item: { path: `/${f.path}` },
              newContent: { content: f.content, contentType: 'rawtext' }
            })),
            comment: message,
            refName: 'refs/heads/main',
          });
          // Parse MCP content parts
          if (result.content && Array.isArray(result.content)) {
            const textContent = result.content.find((item: any) => item.type === 'text');
            if (textContent && textContent.text) {
              return JSON.parse(textContent.text);
            }
          }
          return { success: true };
        }
      } catch (error: any) {
        // Check if it's an "empty repository" error
        const errorMessage = error?.message || String(error);
        const isEmptyRepoError = errorMessage.includes('Git Repository is empty') || 
                                  errorMessage.includes('empty') || 
                                  errorMessage.includes('409') ||
                                  errorMessage.includes('Conflict');
        
        // If it's not an empty repo error or we've exhausted retries, throw
        if (!isEmptyRepoError || attempt === maxRetries) {
          console.error(`Error committing files for ${provider} (attempt ${attempt + 1}/${maxRetries + 1}):`, error);
          throw error;
        }
        
        // Wait before retrying (exponential backoff starting longer)
        const delay = baseDelay * Math.pow(1.5, attempt);
        console.log(`Repository not ready yet, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries + 1})...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw new Error('Failed to commit files after maximum retries');
  }

  async cleanup() {
    const entries = Array.from(this.clients.entries());
    for (const [key, { client, process: childProcess }] of entries) {
      try {
        await client.close();
        childProcess.kill();
      } catch (error) {
        console.error(`Error cleaning up client ${key}:`, error);
      }
    }
    this.clients.clear();
  }
}

export const mcpClient = new MCPClientManager();

// Cleanup on process exit
process.on('exit', () => {
  mcpClient.cleanup();
});
