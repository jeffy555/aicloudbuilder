import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, type ChildProcess } from "child_process";
import { Octokit } from "@octokit/rest";

export type MCPProvider = 'github' | 'azure';
export type MCPServerType = 'devops' | 'resources';

interface MCPClientConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export class MCPClientManager {
  private clients: Map<string, { client: Client; process: ChildProcess }> = new Map();

  private getConfig(provider: MCPProvider, serverType: MCPServerType = 'devops'): MCPClientConfig {
    if (provider === 'github') {
      return {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN || '',
        }
      };
    } else if (provider === 'azure' && serverType === 'resources') {
      // Azure MCP Server for resource management (storage accounts, etc.)
      return {
        command: 'npx',
        args: ['-y', '@azure/mcp@latest'],
        env: {
          // Uses Azure CLI authentication by default
          // Or can use AZURE_SUBSCRIPTION_ID, AZURE_TENANT_ID, etc.
        }
      };
    } else {
      // Azure DevOps MCP Server for repository operations
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

  async getClient(provider: MCPProvider, serverType: MCPServerType = 'devops'): Promise<Client> {
    const clientKey = `${provider}-${serverType}`;
    
    if (this.clients.has(clientKey)) {
      return this.clients.get(clientKey)!.client;
    }

    const config = this.getConfig(provider, serverType);
    const client = new Client({
      name: `ai-devops-${provider}-${serverType}`,
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

  async listTools(provider: MCPProvider): Promise<any> {
    const client = await this.getClient(provider);
    const result = await client.listTools();
    return result;
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
        const result = await this.callTool(provider, 'search_repositories', {
          query: `user:${owner}`,
        });
        // Parse MCP content parts
        if (result.content && Array.isArray(result.content)) {
          const textContent = result.content.find((item: any) => item.type === 'text');
          if (textContent && textContent.text) {
            const parsed = JSON.parse(textContent.text);
            const repos = parsed.items || parsed || [];
            // Convert repository IDs to strings for schema compatibility
            return repos.map((repo: any) => ({
              ...repo,
              id: String(repo.id)
            }));
          }
        }
        return [];
      } else {
        // Azure DevOps
        const result = await this.callTool(provider, 'repo_list_repos_by_project', {
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
        // Create repository WITHOUT auto_init - our Terraform files will be the first commit
        const result = await this.callTool(provider, 'create_repository', {
          owner: process.env.GITHUB_OWNER || '',
          name,
          description: description || '',
          private: false,
          auto_init: false, // Don't initialize - we'll make the first commit ourselves
        });
        // Parse MCP content parts
        let repoData: any = { name };
        if (result.content && Array.isArray(result.content)) {
          const textContent = result.content.find((item: any) => item.type === 'text');
          if (textContent && textContent.text) {
            repoData = JSON.parse(textContent.text);
            // Convert repository ID to string for schema compatibility
            if (repoData.id) {
              repoData.id = String(repoData.id);
            }
          }
        }
        
        console.log(`Repository ${name} created (empty, ready for first commit)`);
        return repoData;
      } else {
        // Azure DevOps - MCP server doesn't support creating repositories
        throw new Error('Azure DevOps MCP server does not support creating repositories. Please create the repository manually in Azure DevOps, then select it from the list.');
      }
    } catch (error) {
      console.error(`Error creating repository for ${provider}:`, error);
      throw error;
    }
  }

  async commitFiles(
    provider: MCPProvider,
    repoName: string,
    files: { path: string; content: string }[],
    message: string
  ): Promise<any> {
    try {
      if (provider === 'github') {
        console.log(`Committing ${files.length} files to ${repoName}...`);
        
        // Try MCP push_files first
        try {
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
              const parsed = JSON.parse(textContent.text);
              console.log(`Successfully committed to ${repoName} via MCP`);
              return parsed;
            }
          }
          return { success: true };
        } catch (mcpError: any) {
          // Check if MCP fails with "Repository is empty" error
          // The error could be in message, data.stderr, or data fields
          const errorMessage = mcpError.message || '';
          const errorStderr = mcpError.data?.stderr || '';
          const errorData = typeof mcpError.data === 'string' ? mcpError.data : '';
          
          const isEmptyRepoError = 
            errorMessage.toLowerCase().includes('repository is empty') ||
            errorStderr.toLowerCase().includes('repository is empty') ||
            errorData.toLowerCase().includes('repository is empty');
          
          if (isEmptyRepoError) {
            console.log(`MCP failed (empty repo detected), falling back to GitHub REST API for initial commit...`);
            console.log(`Error details - Message: ${errorMessage}, Stderr: ${errorStderr}`);
            return await this.commitFilesViaGitHubAPI(repoName, files, message);
          }
          // Re-throw if it's a different error
          throw mcpError;
        }
      } else {
        // Azure DevOps - MCP server doesn't support direct file commits
        throw new Error('Azure DevOps MCP server does not support committing files directly. The server only supports pull request and branch operations.');
      }
    } catch (error: any) {
      console.error(`Error committing files for ${provider}:`, error);
      throw error;
    }
  }

  private async commitFilesViaGitHubAPI(
    repoName: string,
    files: { path: string; content: string }[],
    message: string
  ): Promise<any> {
    const octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });

    const owner = process.env.GITHUB_OWNER || '';

    try {
      console.log(`Creating initial commit for empty repository ${repoName} with ${files.length} files...`);
      
      // Use Contents API to create files one by one
      // This works on empty repositories unlike the Git Data API
      const results = [];
      for (const file of files) {
        console.log(`Creating file: ${file.path}`);
        const result = await octokit.repos.createOrUpdateFileContents({
          owner,
          repo: repoName,
          path: file.path,
          message: `${message} - ${file.path}`,
          content: Buffer.from(file.content).toString('base64'),
          branch: 'main',
        });
        results.push(result.data);
      }

      console.log(`Successfully created ${results.length} files via GitHub REST API`);
      return {
        success: true,
        files: results,
        method: 'github-contents-api',
      };
    } catch (error: any) {
      console.error('Error committing via GitHub REST API:', error);
      console.error('Error response:', error.response?.data);
      throw new Error(`Failed to commit via GitHub REST API: ${error.message}`);
    }
  }

  async scanRepositoryFiles(
    provider: MCPProvider,
    repoName: string,
    branch: string = 'main'
  ): Promise<{ path: string; content: string }[]> {
    try {
      if (provider === 'github') {
        const octokit = new Octokit({
          auth: process.env.GITHUB_TOKEN,
        });

        const owner = process.env.GITHUB_OWNER || '';

        try {
          const { data: tree } = await octokit.rest.git.getTree({
            owner,
            repo: repoName,
            tree_sha: branch,
            recursive: 'true',
          });

          const tfFiles = tree.tree.filter(
            (item) => item.path?.endsWith('.tf') && item.type === 'blob'
          );

          const fileContents = await Promise.all(
            tfFiles.map(async (file) => {
              if (!file.path) return null;

              try {
                const { data } = await octokit.rest.repos.getContent({
                  owner,
                  repo: repoName,
                  path: file.path,
                  ref: branch,
                });

                if ('content' in data && data.content) {
                  const content = Buffer.from(data.content, 'base64').toString('utf-8');
                  return { path: file.path, content };
                }
                return null;
              } catch (error) {
                console.error(`Error reading file ${file.path}:`, error);
                return null;
              }
            })
          );

          return fileContents.filter((f): f is { path: string; content: string } => f !== null);
        } catch (error: any) {
          if (error.status === 409 || error.message?.includes('Git Repository is empty')) {
            console.log(`Repository ${repoName} is empty`);
            return [];
          }
          throw error;
        }
      } else {
        // Azure DevOps - MCP server limitations
        // The Azure DevOps MCP server does not provide file content reading tools
        // Unlike GitHub's MCP which has get_file_contents, Azure DevOps MCP only supports:
        // - Repository listing
        // - Branch/PR management
        // - No direct file content access
        console.log('Azure DevOps MCP does not support file content reading. Repository scanning unavailable for Azure DevOps.');
        console.log('Users with Azure DevOps repos will need to manually configure cloud provider and module type.');
        return [];
      }
    } catch (error) {
      console.error(`Error scanning repository ${repoName}:`, error);
      throw error;
    }
  }

  // Azure Resource Management via Azure MCP Server
  async validateAzureStorageAccount(storageAccountName: string, resourceGroupName: string): Promise<{
    exists: boolean;
    location?: string;
    error?: string;
  }> {
    try {
      const client = await this.getClient('azure', 'resources');
      
      // Use Azure MCP Server to check if storage account exists
      const result = await client.callTool({
        name: 'azure_list_storage_accounts',
        arguments: {}
      });

      // Robustly parse MCP response - handle text, JSON, or multiple content items
      const content = result.content as any[];
      if (!content || content.length === 0) {
        throw new Error('No content returned from Azure MCP server');
      }

      let storageAccounts: any[] = [];
      
      // Iterate through all content items and parse each
      for (const item of content) {
        if (item.type === 'text' && item.text) {
          try {
            const parsed = JSON.parse(item.text);
            storageAccounts = storageAccounts.concat(Array.isArray(parsed) ? parsed : [parsed]);
          } catch (parseError) {
            console.warn('Failed to parse text content as JSON:', item.text);
          }
        } else if (item.type === 'application/json' && item.data) {
          const parsed = typeof item.data === 'string' ? JSON.parse(item.data) : item.data;
          storageAccounts = storageAccounts.concat(Array.isArray(parsed) ? parsed : [parsed]);
        }
      }

      // Check if our storage account exists
      const account = storageAccounts.find((sa: any) => 
        sa.name === storageAccountName && 
        (sa.resourceGroup === resourceGroupName || sa.resource_group === resourceGroupName)
      );

      if (account) {
        return {
          exists: true,
          location: account.location
        };
      }

      return { exists: false };
    } catch (error: any) {
      console.error(`Error validating storage account ${storageAccountName}:`, error);
      // Don't mask real errors as "not found"
      throw new Error(`Failed to validate storage account: ${error.message || 'Unknown error'}`);
    }
  }

  async validateAzureContainer(
    storageAccountName: string, 
    resourceGroupName: string,
    containerName: string
  ): Promise<{
    exists: boolean;
    error?: string;
  }> {
    try {
      const client = await this.getClient('azure', 'resources');
      
      // Use Azure MCP Server to list containers in the storage account
      // Note: Requires both storage_account_name AND resource_group_name
      const result = await client.callTool({
        name: 'azure_list_blob_containers',
        arguments: {
          storage_account_name: storageAccountName,
          resource_group_name: resourceGroupName
        }
      });

      // Robustly parse MCP response - handle text, JSON, or multiple content items
      const content = result.content as any[];
      if (!content || content.length === 0) {
        throw new Error('No content returned from Azure MCP server');
      }

      let containers: any[] = [];
      
      // Iterate through all content items and parse each
      for (const item of content) {
        if (item.type === 'text' && item.text) {
          try {
            const parsed = JSON.parse(item.text);
            containers = containers.concat(Array.isArray(parsed) ? parsed : [parsed]);
          } catch (parseError) {
            console.warn('Failed to parse text content as JSON:', item.text);
          }
        } else if (item.type === 'application/json' && item.data) {
          const parsed = typeof item.data === 'string' ? JSON.parse(item.data) : item.data;
          containers = containers.concat(Array.isArray(parsed) ? parsed : [parsed]);
        }
      }

      const containerExists = containers.some((c: any) => c.name === containerName);
      return { exists: containerExists };
    } catch (error: any) {
      console.error(`Error validating container ${containerName}:`, error);
      // Don't mask real errors as "not found"
      throw new Error(`Failed to validate container: ${error.message || 'Unknown error'}`);
    }
  }

  async createAzureResourceGroup(
    resourceGroupName: string,
    location: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const client = await this.getClient('azure', 'resources');
      
      await client.callTool({
        name: 'azure_create_resource_group',
        arguments: {
          name: resourceGroupName,
          location: location
        }
      });

      return { success: true };
    } catch (error: any) {
      console.error(`Error creating resource group:`, error);
      return {
        success: false,
        error: error.message || 'Failed to create resource group'
      };
    }
  }

  async validateAzureResourceGroup(
    resourceGroupName: string
  ): Promise<{ exists: boolean; location?: string; error?: string }> {
    try {
      const client = await this.getClient('azure', 'resources');
      
      const result = await client.callTool({
        name: 'azure_list_resource_groups',
        arguments: {}
      });

      const content = result.content as any[];
      if (!content || content.length === 0) {
        throw new Error('No content returned from Azure MCP server');
      }

      let resourceGroups: any[] = [];
      
      for (const item of content) {
        if (item.type === 'text' && item.text) {
          try {
            const parsed = JSON.parse(item.text);
            resourceGroups = resourceGroups.concat(Array.isArray(parsed) ? parsed : [parsed]);
          } catch (parseError) {
            console.warn('Failed to parse text content as JSON:', item.text);
          }
        } else if (item.type === 'application/json' && item.data) {
          const parsed = typeof item.data === 'string' ? JSON.parse(item.data) : item.data;
          resourceGroups = resourceGroups.concat(Array.isArray(parsed) ? parsed : [parsed]);
        }
      }

      const rg = resourceGroups.find((r: any) => r.name === resourceGroupName);
      if (rg) {
        return {
          exists: true,
          location: rg.location
        };
      }

      return { exists: false };
    } catch (error: any) {
      console.error(`Error validating resource group ${resourceGroupName}:`, error);
      throw new Error(`Failed to validate resource group: ${error.message || 'Unknown error'}`);
    }
  }

  async createAzureStorageAccount(
    storageAccountName: string,
    resourceGroupName: string,
    location: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const client = await this.getClient('azure', 'resources');
      
      await client.callTool({
        name: 'azure_create_storage_account',
        arguments: {
          name: storageAccountName,
          resource_group: resourceGroupName,
          location: location,
          sku: 'Standard_LRS'
        }
      });

      return { success: true };
    } catch (error: any) {
      console.error(`Error creating storage account:`, error);
      return {
        success: false,
        error: error.message || 'Failed to create storage account'
      };
    }
  }

  async createAzureContainer(
    storageAccountName: string,
    containerName: string,
    resourceGroupName: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const client = await this.getClient('azure', 'resources');
      
      await client.callTool({
        name: 'azure_create_blob_container',
        arguments: {
          storage_account_name: storageAccountName,
          container_name: containerName,
          resource_group_name: resourceGroupName
        }
      });

      return { success: true };
    } catch (error: any) {
      console.error(`Error creating container:`, error);
      return {
        success: false,
        error: error.message || 'Failed to create container'
      };
    }
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
