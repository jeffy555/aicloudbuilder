import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, type ChildProcess } from "child_process";
import { Octokit } from "@octokit/rest";

export type MCPProvider = 'github' | 'azure' | 'terraform';
export type MCPServerType = 'devops' | 'resources' | 'pricing';

export interface RepositoryCredentials {
  github?: {
    token: string;
    owner?: string;
  };
  azure?: {
    org: string;
    pat: string;
    project: string;
  };
}

interface MCPClientConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export class MCPClientManager {
  private clients: Map<string, { client: Client; process: ChildProcess }> = new Map();
  private repoCache: Map<string, { data: any[]; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 60_000; // Cache repos for 60 seconds

  /**
   * Retry a function with exponential backoff for 429 errors
   */
  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 2000): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        const is429 = error.status === 429 || error.response?.status === 429;
        if (!is429 || attempt === maxRetries) {
          throw error;
        }
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.log(`   ⏳ Rate limited (429). Retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error('Max retries exceeded');
  }
  
  // Pre-warm connection for a provider (call this when provider is selected)
  async prewarmConnection(provider: MCPProvider, serverType: MCPServerType = 'devops'): Promise<void> {
    const clientKey = `${provider}-${serverType}`;
    if (this.clients.has(clientKey)) {
      console.log(`⚡ [MCP] Connection already warm for ${clientKey}`);
      return;
    }
    
    console.log(`🔥 [MCP] Pre-warming connection for ${clientKey}...`);
    try {
      await this.getClient(provider, serverType);
      console.log(`✅ [MCP] Connection pre-warmed for ${clientKey}`);
    } catch (error: any) {
      console.warn(`⚠️  [MCP] Failed to pre-warm connection for ${clientKey}: ${error.message}`);
      // Don't throw - pre-warming is optional
    }
  }

  private getConfig(provider: MCPProvider, serverType: MCPServerType = 'devops'): MCPClientConfig {
    if (provider === 'terraform') {
      // Terraform MCP Server for version information and documentation
      // Package: terraform-mcp-server (not @hashicorp/terraform-mcp-server)
      // Published by: thrashr888
      return {
        command: 'npx',
        args: ['-y', 'terraform-mcp-server'],
        env: {}
      };
    } else if (provider === 'github') {
      return {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN || '',
        }
      };
    } else if (provider === 'azure' && serverType === 'pricing') {
      // Azure Pricing MCP Server for cost estimation
      // Uses Azure Retail Prices API (public, no auth needed)
      // Note: This is a separate MCP server from the resource management one
      // Installation: npm install -g @azure/mcp-pricing (or use npx)
      return {
        command: 'npx',
        args: ['-y', '@azure/mcp-pricing@latest'],
        env: {
          // No authentication needed - uses public Azure Retail Prices API
        }
      };
    } else if (provider === 'azure' && serverType === 'resources') {
      // Azure MCP Server for resource management (storage accounts, etc.)
      // Supports multiple authentication methods via DefaultAzureCredential (tries in order):
      // 1. Environment Variables (Service Principal with secret or certificate)
      // 2. Managed Identity (if running on Azure)
      // 3. Visual Studio credentials
      // 4. Azure CLI (az login)
      // 5. Azure PowerShell (Connect-AzAccount)
      // 6. Azure Developer CLI (azd auth login)
      // 7. Interactive Browser (fallback)
      const env: Record<string, string> = {};
      
      // Option 1: Service Principal with Client Secret
      if (process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET) {
        env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID;
        env.AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
        env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || '';
        env.AZURE_SUBSCRIPTION_ID = process.env.AZURE_SUBSCRIPTION_ID || '';
        console.log('Using Service Principal (Client Secret) authentication for Azure MCP');
      }
      // Option 2: Service Principal with Certificate
      else if (process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_CERTIFICATE_PATH) {
        env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID;
        env.AZURE_CLIENT_CERTIFICATE_PATH = process.env.AZURE_CLIENT_CERTIFICATE_PATH;
        env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || '';
        env.AZURE_SUBSCRIPTION_ID = process.env.AZURE_SUBSCRIPTION_ID || '';
        console.log('Using Service Principal (Certificate) authentication for Azure MCP');
      }
      // Option 3: Workload Identity Federation (for GitHub Actions, Kubernetes)
      else if (process.env.AZURE_CLIENT_ID && process.env.AZURE_FEDERATED_TOKEN_FILE) {
        env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID;
        env.AZURE_FEDERATED_TOKEN_FILE = process.env.AZURE_FEDERATED_TOKEN_FILE;
        env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || '';
        env.AZURE_SUBSCRIPTION_ID = process.env.AZURE_SUBSCRIPTION_ID || '';
        console.log('Using Workload Identity Federation authentication for Azure MCP');
      }
      // Option 4: Managed Identity (automatically detected if running on Azure)
      else if (process.env.AZURE_SUBSCRIPTION_ID) {
        env.AZURE_SUBSCRIPTION_ID = process.env.AZURE_SUBSCRIPTION_ID;
        console.log('Using Managed Identity or Azure CLI authentication (will auto-detect)');
      }
      // Option 5: Fallback to Azure CLI / Visual Studio / PowerShell / Azure Developer CLI
      else {
        console.log('Using DefaultAzureCredential chain (will try: Managed Identity → VS → Azure CLI → PowerShell → Azure Developer CLI → Interactive)');
      }
      
      return {
        command: 'npx',
        args: ['-y', '@azure/mcp@latest', 'server', 'start'],
        env
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
    const startTime = Date.now();
    
    // Check cache first
    if (this.clients.has(clientKey)) {
      const cachedTime = Date.now() - startTime;
      console.log(`⚡ [MCP] Using cached client for ${clientKey} (${cachedTime}ms)`);
      return this.clients.get(clientKey)!.client;
    }

    console.log(`🔄 [MCP] Creating new client for ${clientKey}...`);
    const config = this.getConfig(provider, serverType);
    const client = new Client({
      name: `ai-devops-${provider}-${serverType}`,
      version: '1.0.0',
    }, {
      capabilities: {}
    });

    // On Windows, npx needs to be run through shell
    const isWindows = process.platform === 'win32';
    const childProcess = spawn(config.command, config.args, {
      env: { ...process.env, ...config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWindows, // Enable shell on Windows to find npx
    });

    // Handle spawn errors
    childProcess.on('error', (error) => {
      console.error(`❌ Failed to spawn MCP server for ${provider}-${serverType}:`, error);
      console.error(`   Command: ${config.command} ${config.args.join(' ')}`);
      console.error(`   Error: ${error.message}`);
      console.error(`   Make sure ${config.command} is available in your PATH`);
    });
    
    // Capture stdout and stderr for better error messages
    let stdoutOutput = '';
    let stderrOutput = '';
    
    // Monitor process stdout for debugging
    if (childProcess.stdout) {
      childProcess.stdout.on('data', (data) => {
        const output = data.toString();
        stdoutOutput += output;
        console.log(`   [MCP stdout] ${output.trim()}`);
      });
    }
    
    // Monitor process stderr for debugging
    if (childProcess.stderr) {
      childProcess.stderr.on('data', (data) => {
        const output = data.toString();
        stderrOutput += output;
        console.error(`   [MCP stderr] ${output.trim()}`);
      });
    }
    
    // Monitor process exit
    childProcess.on('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        console.error(`   [MCP process exited] Code: ${code}, Signal: ${signal}`);
      }
    });

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...config.env } as Record<string, string>
    });

    try {
      const connectStart = Date.now();
      console.log(`   🔌 Attempting to connect to MCP server...`);
      console.log(`   Command: ${config.command} ${config.args.join(' ')}`);
      
      // Add timeout for connection (longer for Azure resources server)
      const timeoutDuration = (provider === 'azure' && serverType === 'resources') ? 30000 : 10000;
      const connectPromise = client.connect(transport);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`Connection timeout after ${timeoutDuration / 1000} seconds`)), timeoutDuration)
      );
      
      await Promise.race([connectPromise, timeoutPromise]);
      const connectTime = Date.now() - connectStart;
      console.log(`✅ Connected to MCP server for ${provider}-${serverType} (${connectTime}ms)`);
      
      // For Azure resources, wait a bit more to ensure server is fully initialized
      if (provider === 'azure' && serverType === 'resources') {
        // Give the server a moment to fully initialize after connection
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Try to list tools to verify server is ready
        try {
          await client.listTools();
          console.log(`   ✅ Azure MCP server is ready and responding`);
        } catch (toolError: any) {
          console.warn(`   ⚠️  Azure MCP server connected but tools not ready: ${toolError.message}`);
          // Don't throw - connection is established, tools might be available later
        }
      }
      
      const totalTime = Date.now() - startTime;
      console.log(`⏱️  [MCP] Total client creation time: ${totalTime}ms`);
    } catch (error: any) {
      console.error(`❌ Failed to connect to MCP server for ${provider}-${serverType}:`, error);
      console.error(`   Error type: ${error.constructor?.name || typeof error}`);
      console.error(`   Error message: ${error.message || String(error)}`);
      console.error(`   Error code: ${error.code || 'N/A'}`);
      if (error.stack) {
        console.error(`   Stack trace: ${error.stack.substring(0, 500)}`);
      }
      console.error(`   Command: ${config.command} ${config.args.join(' ')}`);
      if (config.env) {
        console.error(`   Environment variables: ${Object.keys(config.env).join(', ')}`);
      }
      
      // Check if process is still running
      if (childProcess && !childProcess.killed) {
        console.error(`   Process PID: ${childProcess.pid}`);
        console.error(`   Process killed: ${childProcess.killed}`);
      }
      
      // Wait a bit for stderr to be fully captured before killing process
      await new Promise(resolve => setTimeout(resolve, 500));
      
      childProcess.kill(); // Clean up the spawned process
      
      // Provide more specific error message
      let errorMessage = error.message || 'Unknown error';
      
      // Include stderr output if available (contains actual server error)
      if (stderrOutput.trim()) {
        errorMessage += `\n\nServer Error Output:\n${stderrOutput.trim()}`;
      }
      
      // Include stdout output if available (may contain useful info)
      if (stdoutOutput.trim() && !errorMessage.includes(stdoutOutput.trim())) {
        errorMessage += `\n\nServer Output:\n${stdoutOutput.trim()}`;
      }
      
      if (errorMessage.includes('Connection closed') || errorMessage.includes('-32000')) {
        // Special handling for Terraform MCP server
        if (provider === 'terraform') {
          errorMessage = `Terraform MCP server connection closed immediately. This usually means:
1. The MCP server process crashed on startup
2. The package terraform-mcp-server may not be installed correctly
3. There's a compatibility issue with the MCP server
4. The server requires additional configuration or environment variables

TROUBLESHOOTING STEPS:
1. Test if package exists: npx -y terraform-mcp-server --version
2. Check package availability: npm view terraform-mcp-server
3. Try manual start: npx -y terraform-mcp-server
4. Check Node.js version: node --version (should be >= 18)
5. Clear npm cache: npm cache clean --force
6. Verify npx is working: npx --version
7. Install globally: npm install -g terraform-mcp-server

NOTE: The package name is 'terraform-mcp-server' (not @hashicorp/terraform-mcp-server).
The system will fall back to GitHub API for version information and OpenAI for code generation.`;
        } else if (provider === 'azure' && serverType === 'resources') {
          // Special handling for Azure MCP server
          errorMessage = `Azure MCP server connection closed immediately. This usually means:
1. The MCP server process crashed on startup (likely authentication failure)
2. Azure credentials are not configured correctly
3. The MCP server is not installed correctly
4. There's a compatibility issue with the MCP server

AUTHENTICATION REQUIREMENTS:
The Azure MCP server requires one of these authentication methods:
- Service Principal (AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID)
- Azure CLI login (az login)
- Managed Identity (if running on Azure)
- Visual Studio credentials
- Azure PowerShell credentials

TROUBLESHOOTING STEPS:
1. Check Azure credentials: echo $AZURE_CLIENT_ID (should be set)
2. Test Azure CLI: az account show (should show your subscription)
3. Try manual start: npx -y @azure/mcp@latest server start
4. Check Node.js version: node --version (should be >= 18)
5. Verify npx is working: npx --version

${stderrOutput.trim() ? `\nACTUAL SERVER ERROR:\n${stderrOutput.trim()}` : ''}

Try running manually: ${config.command} ${config.args.join(' ')}
Check if the MCP server package is properly installed.`;
        } else {
          errorMessage = `MCP server connection closed immediately. This usually means:
1. The MCP server process crashed on startup
2. The MCP server is not installed correctly
3. There's a compatibility issue with the MCP server
4. The server requires additional configuration or environment variables

${stderrOutput.trim() ? `\nACTUAL SERVER ERROR:\n${stderrOutput.trim()}` : ''}

Try running manually: ${config.command} ${config.args.join(' ')}
Check if the MCP server package is properly installed.`;
        }
      }
      
      throw new Error(`MCP server connection failed: ${errorMessage}`);
    }

    this.clients.set(clientKey, { client, process: childProcess });

    return client;
  }

  async listTools(provider: MCPProvider): Promise<any> {
    const client = await this.getClient(provider);
    const result = await client.listTools();
    return result;
  }

  async callPricingTool(toolName: string, args: Record<string, any>): Promise<any> {
    const client = await this.getClient('azure', 'pricing');
    
    const result = await client.callTool({
      name: toolName,
      arguments: args
    });
    
    return result;
  }

  async callTool(provider: MCPProvider, toolName: string, args: Record<string, any>): Promise<any> {
    const callStart = Date.now();
    const client = await this.getClient(provider);
    const clientTime = Date.now() - callStart;
    
    if (clientTime > 100) {
      console.log(`⏱️  [MCP] Client acquisition took ${clientTime}ms (${provider})`);
    }
    
    // Verify tool exists before calling
    try {
      const tools = await client.listTools();
      const toolExists = tools.tools?.some((t: any) => t.name === toolName);
      if (!toolExists) {
        const availableTools = tools.tools?.map((t: any) => t.name).join(', ') || 'none';
        throw new Error(`Tool '${toolName}' not found in ${provider} MCP server. Available tools: ${availableTools}`);
      }
    } catch (listError: any) {
      console.warn(`⚠️  Could not verify tool existence: ${listError.message}`);
      // Continue anyway - might be a connection issue
    }
    
    const toolStart = Date.now();
    try {
    const result = await client.callTool({
      name: toolName,
      arguments: args
    });
      const toolTime = Date.now() - toolStart;
      
      if (toolTime > 500) {
        console.log(`⏱️  [MCP] Tool call '${toolName}' took ${toolTime}ms (${provider})`);
      }

    return result;
    } catch (error: any) {
      // Capture full error details for debugging
      const errorMessage = error.message || String(error);
      const errorCode = error.code || '';
      const errorData = error.data || '';
      const errorStack = error.stack || '';
      
      // Log full error details for debugging
      console.error(`\n🔍 [MCP callTool] Full error details:`);
      console.error(`   Tool: ${toolName}`);
      console.error(`   Provider: ${provider}`);
      console.error(`   Arguments:`, JSON.stringify(args, null, 2));
      console.error(`   Message: ${errorMessage}`);
      console.error(`   Code: ${errorCode}`);
      console.error(`   Data:`, errorData);
      console.error(`   Stack:`, errorStack);
      
      // Try to get more details from the error object
      const errorKeys = Object.getOwnPropertyNames(error);
      console.error(`   Error properties:`, errorKeys);
      errorKeys.forEach(key => {
        if (key !== 'message' && key !== 'stack') {
          try {
            console.error(`   ${key}:`, JSON.stringify(error[key], null, 2));
          } catch {
            console.error(`   ${key}:`, error[key]);
          }
        }
      });
      
      // Create enhanced error with all details
      const enhancedError: any = new Error(`MCP error ${errorCode}: ${errorMessage}`);
      enhancedError.code = errorCode;
      enhancedError.data = errorData;
      enhancedError.tool = toolName;
      enhancedError.provider = provider;
      enhancedError.originalError = error;
      enhancedError.isNotFound = errorMessage.includes('Not Found') || errorMessage.includes('not found') || errorCode === '-32603';
      
      throw enhancedError;
    }
  }

  // Fetch Terraform documentation/examples from MCP server for AI to use
  async fetchTerraformDocumentation(
    resources: string[],
    cloudProvider: string | null
  ): Promise<string> {
    try {
      console.log(`   📡 Step 2.1: Connecting to Terraform MCP server...`);
      console.log(`   📡 Step 2.2: Calling getClient('terraform')...`);
      
      let client;
      try {
        client = await this.getClient('terraform');
        console.log(`   ✅ Step 2.3: Successfully obtained MCP client`);
      } catch (clientError: any) {
        console.error(`   ❌ Step 2.3: Failed to get MCP client:`, clientError);
        throw clientError;
      }
      
      console.log(`   📡 Step 2.4: Listing available tools...`);
      let tools;
      try {
        tools = await client.listTools();
        console.log(`   ✅ Step 2.5: Successfully listed tools`);
      } catch (toolsError: any) {
        console.error(`   ❌ Step 2.5: Failed to list tools:`, toolsError);
        throw new Error(`Failed to list MCP tools: ${toolsError.message || 'Unknown error'}`);
      }
      
      console.log(`   ✅ Terraform MCP server connected`);
      console.log(`   🔧 Available tools: ${tools.tools?.map((t: any) => t.name).join(', ') || 'none'}`);
      
      // List all tools for debugging
      console.log(`   All available tools: ${JSON.stringify(tools.tools?.map((t: any) => ({ 
        name: t.name, 
        description: t.description?.substring(0, 100) || 'N/A',
        inputSchema: t.inputSchema ? 'has schema' : 'no schema'
      })), null, 2)}`);
      
      // Look for documentation/examples tools
      // Common names: get_documentation, get_examples, search_docs, get_resource_docs, etc.
      let docTool = tools.tools?.find((tool: any) => 
        tool.name?.toLowerCase().includes('documentation') ||
        tool.name?.toLowerCase().includes('docs') ||
        tool.name?.toLowerCase().includes('example') ||
        tool.name?.toLowerCase().includes('reference') ||
        tool.name?.toLowerCase().includes('search')
      );
      
      if (!docTool && tools.tools && tools.tools.length > 0) {
        // Use first available tool if no doc tool found
        docTool = tools.tools[0];
        console.log(`   ⚠️  No documentation tool found, using first available: ${docTool.name}`);
      }
      
      if (!docTool) {
        throw new Error('No tools available in Terraform MCP server');
      }
      
      console.log(`   Using tool: ${docTool.name}`);
      console.log(`   Description: ${docTool.description || 'N/A'}`);
      
      // Fetch documentation for each resource
      let allDocs = '';
      for (const resource of resources) {
        try {
          console.log(`   📚 Fetching docs for: ${resource}`);
          
          // Prepare arguments based on tool schema
          const args: Record<string, any> = {};
          const inputSchema = docTool.inputSchema;
          
          if (inputSchema?.properties) {
            const props = inputSchema.properties;
            // Try common parameter names
            if (props.resource || props.resourceType || props.name) {
              const key = props.resource ? 'resource' : props.resourceType ? 'resourceType' : 'name';
              args[key] = resource;
            }
            if (props.provider || props.cloudProvider) {
              const key = props.provider ? 'provider' : 'cloudProvider';
              if (cloudProvider) args[key] = cloudProvider;
            }
          } else {
            // Default: try common names
            args.resource = resource;
            args.resourceType = resource;
            if (cloudProvider) args.provider = cloudProvider;
          }
          
          const result = await client.callTool({
            name: docTool.name,
            arguments: args
          });
          
          // Extract documentation from response
          if (result.content && Array.isArray(result.content)) {
            for (const item of result.content) {
              if (item.type === 'text' && item.text) {
                allDocs += `\n\n## ${resource}\n${item.text}\n`;
              } else if (item.type === 'application/json' && item.data) {
                const data = typeof item.data === 'string' ? JSON.parse(item.data) : item.data;
                if (typeof data === 'string') {
                  allDocs += `\n\n## ${resource}\n${data}\n`;
                } else if (data.content || data.documentation || data.example) {
                  allDocs += `\n\n## ${resource}\n${JSON.stringify(data, null, 2)}\n`;
                }
              }
            }
          }
          
          console.log(`   ✅ Fetched docs for ${resource}`);
        } catch (resourceError: any) {
          console.warn(`   ⚠️  Failed to fetch docs for ${resource}: ${resourceError.message}`);
          // Continue with other resources
        }
      }
      
      if (!allDocs.trim()) {
        throw new Error('No documentation retrieved from Terraform MCP server');
      }
      
      console.log(`   ✅ Fetched documentation for ${resources.length} resource(s)`);
      return allDocs;
    } catch (error: any) {
      console.error(`❌ Error fetching Terraform documentation:`, error);
      throw new Error(`Terraform MCP server error: ${error.message || 'Unknown error'}`);
    }
  }

  // OLD METHOD - Keeping for reference but should use fetchTerraformDocumentation instead
  async generateTerraformCode(
    description: string,
    cloudProvider: string | null,
    moduleApproach: string | null
  ): Promise<{
    files: Array<{ path: string; content: string }>;
  }> {
    try {
      console.log(`   📡 Step 2.1: Connecting to Terraform MCP server...`);
      console.log(`   📡 Step 2.2: Calling getClient('terraform')...`);
      
      let client;
      try {
        client = await this.getClient('terraform');
        console.log(`   ✅ Step 2.3: Successfully obtained MCP client`);
      } catch (clientError: any) {
        console.error(`   ❌ Step 2.3: Failed to get MCP client:`, clientError);
        console.error(`   Error details:`, {
          message: clientError?.message,
          code: clientError?.code,
          name: clientError?.name
        });
        throw clientError;
      }
      
      console.log(`   📡 Step 2.4: Listing available tools...`);
      let tools;
      try {
        tools = await client.listTools();
        console.log(`   ✅ Step 2.5: Successfully listed tools`);
      } catch (toolsError: any) {
        console.error(`   ❌ Step 2.5: Failed to list tools:`, toolsError);
        console.error(`   Error details:`, {
          message: toolsError?.message,
          code: toolsError?.code,
          name: toolsError?.name
        });
        throw new Error(`Failed to list MCP tools: ${toolsError.message || 'Unknown error'}`);
      }
      
      console.log(`   ✅ Terraform MCP server connected`);
      console.log(`   🔧 Available tools: ${tools.tools?.map((t: any) => t.name).join(', ') || 'none'}`);
      
      // List all tools for debugging
      console.log(`   All available tools: ${JSON.stringify(tools.tools?.map((t: any) => ({ 
        name: t.name, 
        description: t.description?.substring(0, 100) || 'N/A',
        inputSchema: t.inputSchema ? 'has schema' : 'no schema'
      })), null, 2)}`);
      
      // Look for code generation tools - try common names first
      // Terraform MCP server might use: terraform_generate, generate_terraform, create_terraform, etc.
      let generateTool = tools.tools?.find((tool: any) => 
        tool.name?.toLowerCase() === 'terraform_generate' ||
        tool.name?.toLowerCase() === 'generate_terraform' ||
        tool.name?.toLowerCase() === 'create_terraform'
      );
      
      // If not found, try partial matches
      if (!generateTool) {
        generateTool = tools.tools?.find((tool: any) => 
          tool.name?.toLowerCase().includes('generate') ||
          tool.name?.toLowerCase().includes('create') ||
          tool.name?.toLowerCase().includes('code') ||
          (tool.name?.toLowerCase().includes('terraform') && 
           !tool.name?.toLowerCase().includes('version') &&
           !tool.name?.toLowerCase().includes('validate'))
        );
      }
      
      // If still not found, use the first tool (might be the only one)
      if (!generateTool && tools.tools && tools.tools.length > 0) {
        generateTool = tools.tools[0];
        console.log(`   ⚠️  No specific generation tool found, using first available tool: ${generateTool.name}`);
      }
      
      if (!generateTool) {
        throw new Error('No tools available in Terraform MCP server');
      }
      
      console.log(`   Using tool: ${generateTool.name}`);
      console.log(`   Description: ${generateTool.description || 'N/A'}`);
      
      // Check tool input schema to understand expected parameters
      const inputSchema = generateTool.inputSchema;
      if (inputSchema && inputSchema.properties) {
        console.log(`   Tool expects parameters: ${Object.keys(inputSchema.properties).join(', ')}`);
      }
      
      // Prepare arguments based on tool schema
      const args: Record<string, any> = {};
      
      // Try to match schema properties
      if (inputSchema?.properties) {
        const props = inputSchema.properties;
        
        // Map description
        if (props.description || props.prompt || props.query || props.input) {
          const descKey = props.description ? 'description' : 
                         props.prompt ? 'prompt' : 
                         props.query ? 'query' : 'input';
          args[descKey] = description;
        } else {
          // Default: use description
          args.description = description;
        }
        
        // Map cloud provider
        if (props.cloudProvider || props.provider || props.cloud) {
          const providerKey = props.cloudProvider ? 'cloudProvider' : 
                             props.provider ? 'provider' : 'cloud';
          if (cloudProvider) {
            args[providerKey] = cloudProvider;
          }
        }
        
        // Map module approach
        if (props.moduleApproach || props.approach || props.moduleType) {
          const approachKey = props.moduleApproach ? 'moduleApproach' : 
                            props.approach ? 'approach' : 'moduleType';
          if (moduleApproach) {
            args[approachKey] = moduleApproach;
          }
        }
      } else {
        // No schema, use common parameter names
        args.description = description;
        if (cloudProvider) {
          args.cloudProvider = cloudProvider;
          args.provider = cloudProvider;
        }
        if (moduleApproach) {
          args.moduleApproach = moduleApproach;
          args.approach = moduleApproach;
        }
      }
      
      console.log(`   Calling tool with arguments: ${JSON.stringify(Object.keys(args))}`);
      
      // Call the tool
      console.log(`   🚀 Calling MCP tool: ${generateTool.name}`);
      console.log(`   📤 Sending request with description: "${description.substring(0, 100)}${description.length > 100 ? '...' : ''}"`);
      
      const result = await client.callTool({
        name: generateTool.name,
        arguments: args
      });
      
      console.log(`   📥 Received response from MCP server`);
      
      // Parse the response
      let files: Array<{ path: string; content: string }> = [];
      
      if (result.content && Array.isArray(result.content)) {
        for (const item of result.content) {
          if (item.type === 'text' && item.text) {
            try {
              // Try to parse as JSON
              const parsed = JSON.parse(item.text);
              if (parsed.files && Array.isArray(parsed.files)) {
                files = parsed.files;
                break;
              }
            } catch {
              // Not JSON, might be raw Terraform code
              // Try to extract files from text
              console.log(`   Received text response (not JSON), attempting to parse...`);
            }
          } else if (item.type === 'application/json' && item.data) {
            const parsed = typeof item.data === 'string' ? JSON.parse(item.data) : item.data;
            if (parsed.files && Array.isArray(parsed.files)) {
              files = parsed.files;
              break;
            }
          }
        }
      }
      
      if (files.length === 0) {
        throw new Error('Terraform MCP server returned no files');
      }
      
      console.log(`   ✅ Generated ${files.length} file(s) from Terraform MCP server`);
      return { files };
    } catch (error: any) {
      console.error(`❌ Error calling Terraform MCP server:`, error);
      throw new Error(`Terraform MCP server error: ${error.message || 'Unknown error'}`);
    }
  }

  async listRepositories(provider: MCPProvider, credentials: RepositoryCredentials = {}): Promise<any[]> {
    const startTime = Date.now();
    try {
      if (provider === 'github') {
        const owner = credentials.github?.owner || process.env.GITHUB_OWNER || '';
        const token = credentials.github?.token || process.env.GITHUB_TOKEN || '';
        if (!token) {
          throw new Error("Missing GITHUB_TOKEN environment variable.");
        }

        // Check cache first to avoid hitting rate limits
        const cacheKey = `github:${owner}`;
        const cached = this.repoCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
          console.log(`📡 [GitHub] Returning ${cached.data.length} cached repositories (${Math.round((Date.now() - cached.timestamp) / 1000)}s old)`);
          return cached.data;
        }

        console.log(`📡 [GitHub] Fetching repositories for owner: ${owner || 'authenticated user'}`);
        const octokit = new Octokit({ auth: token });

        const response = await this.withRetry(async () => {
          return await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
            visibility: "all",
            affiliation: "owner,collaborator,organization_member",
            per_page: 100,
          });
        });

        const filteredResponse = owner
          ? response.filter(
              (repo) =>
                repo.owner?.login &&
                repo.owner.login.toLowerCase() === owner.toLowerCase()
            )
          : response;
        console.log(
          `✅ [GitHub] Retrieved ${filteredResponse.length} repositories via REST API`
        );
        const result = filteredResponse.map((repo) => ({
          id: String(repo.id),
          name: repo.name || repo.full_name,
          full_name: repo.full_name,
          default_branch: repo.default_branch || "main",
          updated_at: repo.updated_at,
          url: repo.html_url,
        }));

        // Cache the result
        this.repoCache.set(cacheKey, { data: result, timestamp: Date.now() });
        return result;
      } else if (provider === 'azure') {
        // Azure DevOps - Use REST API directly (MCP is unreliable/hangs)
        // MCP has known issues with Azure DevOps, so we'll use REST API as primary
        const org = credentials.azure?.org || process.env.AZURE_DEVOPS_ORG;
        const pat = credentials.azure?.pat || process.env.AZURE_DEVOPS_PAT;
        const project = credentials.azure?.project || process.env.AZURE_DEVOPS_PROJECT;
        
        console.log(`📡 [Azure DevOps] Starting repository listing...`);
        console.log(`   Organization: ${org || 'NOT SET'}`);
        console.log(`   Project: ${project || 'NOT SET'}`);
        console.log(`   PAT: ${pat ? 'SET (***)' : 'NOT SET'}`);
        
        if (!org || !pat || !project) {
          throw new Error('Azure DevOps credentials not configured. Please set AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT, and AZURE_DEVOPS_PROJECT environment variables.');
        }
        
        // Use REST API directly (MCP is unreliable for Azure DevOps)
        console.log(`📡 [Azure DevOps] Using REST API directly (MCP is unreliable for Azure DevOps)`);
        return await this.listRepositoriesViaAzureDevOpsAPI();
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }
    } catch (error) {
      console.error(`Error listing repositories for ${provider}:`, error);
      throw error;
    }
  }

  async listRepositoryBranches(
    provider: MCPProvider,
    repoName: string,
    limit: number = 50
  ): Promise<string[]> {
    try {
      if (provider === 'github') {
        const octokit = new Octokit({
          auth: process.env.GITHUB_TOKEN,
        });

        let owner = process.env.GITHUB_OWNER || '';
        let repo = repoName;

        if (repoName.includes("/")) {
          const parts = repoName.split("/");
          owner = parts[0];
          repo = parts[1];
        }

        if (!owner || !repo) {
          throw new Error("Unable to determine GitHub owner/repo from selection.");
        }

        const perPage = Math.min(limit, 100);
        const { data } = await octokit.rest.repos.listBranches({
          owner,
          repo,
          per_page: perPage,
        });

        return data.map((branch) => branch.name).filter(Boolean);
      } else if (provider === "azure") {
        const org = process.env.AZURE_DEVOPS_ORG;
        const pat = process.env.AZURE_DEVOPS_PAT;
        const project = process.env.AZURE_DEVOPS_PROJECT;

        if (!org || !pat || !project) {
          throw new Error("Azure DevOps credentials not configured.");
        }

        const repoId = await this.getAzureDevOpsRepositoryId(org, pat, project, repoName);
        const url = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repoId}/refs?filter=heads/&api-version=7.1`;
        const authHeader = Buffer.from(`:${pat}`).toString("base64");

        const response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Basic ${authHeader}`,
          },
        });

        if (!response.ok) {
          throw new Error(`Failed to list branches: ${response.statusText}`);
        }

        const data = await response.json();
        const refs = Array.isArray(data.value) ? data.value : [];
        return refs
          .map((ref: any) => typeof ref.name === "string" && ref.name.replace("refs/heads/", ""))
          .filter((name: unknown): name is string => typeof name === "string" && name.length > 0)
          .slice(0, limit);
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }
    } catch (error: any) {
      console.error(`Error listing branches for ${provider} ${repoName}:`, error);
      throw error;
    }
  }

  async createRepository(
    provider: MCPProvider,
    name: string,
    description?: string,
    credentials: RepositoryCredentials = {}
  ): Promise<any> {
    try {
      if (provider === 'github') {
        // GitHub - Use REST API so we can honor per-user Bitwarden credentials
        const token = credentials.github?.token || process.env.GITHUB_TOKEN || '';
        const owner = credentials.github?.owner || process.env.GITHUB_OWNER || '';
        if (!token) {
          throw new Error('GitHub credentials not configured. Missing token.');
        }

        const octokit = new Octokit({ auth: token });
        let createdRepo: any;

        // If owner is supplied, attempt org creation first (best for org repos)
        if (owner) {
          try {
            const { data } = await octokit.rest.repos.createInOrg({
              org: owner,
              name,
              description: description || '',
              private: false,
              auto_init: false,
            });
            createdRepo = data;
          } catch (orgError: any) {
            // Fallback: create under authenticated user account
            console.warn(`⚠️ createInOrg failed for ${owner}, falling back to user repo creation: ${orgError?.message}`);
          }
        }

        if (!createdRepo) {
          const { data } = await octokit.rest.repos.createForAuthenticatedUser({
            name,
            description: description || '',
            private: false,
            auto_init: false,
          });
          createdRepo = data;
        }

        console.log(`✅ Repository ${name} created via GitHub REST API`);
        return {
          id: String(createdRepo.id),
          name: createdRepo.name,
          full_name: createdRepo.full_name,
          default_branch: createdRepo.default_branch || 'main',
          updated_at: createdRepo.updated_at,
          url: createdRepo.html_url,
        };
      } else if (provider === 'azure') {
        // Azure DevOps - Use REST API directly with Bitwarden/user credentials support
        const org = credentials.azure?.org || process.env.AZURE_DEVOPS_ORG;
        const pat = credentials.azure?.pat || process.env.AZURE_DEVOPS_PAT;
        const project = credentials.azure?.project || process.env.AZURE_DEVOPS_PROJECT;
        
        if (!org || !pat || !project) {
          throw new Error('Azure DevOps credentials not configured. Please set AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT, and AZURE_DEVOPS_PROJECT environment variables.');
        }
        
        // Get project ID first (needed for repository creation)
        const projectId = await this.getAzureDevOpsProjectId(org, pat, project);
        
        // Create repository via Azure DevOps REST API
        const apiUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories?api-version=7.1`;
        const authHeader = Buffer.from(`:${pat}`).toString('base64');
        
        const requestBody = {
          name: name,
          project: {
            id: projectId
          }
        };
        
        console.log(`📤 Creating Azure DevOps repository "${name}" via REST API...`);
        console.log(`   Organization: ${org}`);
        console.log(`   Project: ${project} (ID: ${projectId})`);
        
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${authHeader}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`❌ Azure DevOps API error: ${response.status} ${response.statusText}`);
          console.error(`   Response: ${errorText}`);
          
          // Handle specific error cases
          if (response.status === 409) {
            throw new Error(`A repository named "${name}" already exists in this project. Please choose a different name.`);
          } else if (response.status === 401 || response.status === 403) {
            throw new Error('Azure DevOps authentication failed. Please check your PAT permissions (Code > Read & Write).');
      } else {
            throw new Error(`Failed to create repository: ${response.statusText}. ${errorText}`);
          }
        }
        
        const repoData = await response.json();
        
        // Format response to match expected structure
        const formattedRepo = {
          id: String(repoData.id || repoData.repository?.id || ''),
          name: repoData.name || repoData.repository?.name || name,
          url: repoData.url || repoData.remoteUrl || repoData.repository?.remoteUrl || '',
          defaultBranch: repoData.defaultBranch || repoData.repository?.defaultBranch || 'main',
          project: {
            id: projectId,
            name: project
          }
        };
        
        console.log(`✅ Repository "${name}" created successfully via Azure DevOps REST API`);
        console.log(`   Repository ID: ${formattedRepo.id}`);
        console.log(`   URL: ${formattedRepo.url}`);
        
        return formattedRepo;
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }
    } catch (error) {
      console.error(`❌ Error creating repository for ${provider}:`, error);
      throw error;
    }
  }
  
  /**
   * Get Azure DevOps project ID by project name
   */
  private async getAzureDevOpsProjectId(org: string, pat: string, projectName: string): Promise<string> {
    try {
      // Try to get project by name
      const apiUrl = `https://dev.azure.com/${org}/_apis/projects/${encodeURIComponent(projectName)}?api-version=7.1`;
      const authHeader = Buffer.from(`:${pat}`).toString('base64');
      
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${authHeader}`,
        },
      });
      
      if (!response.ok) {
        // If project name lookup fails, try listing all projects
        const listUrl = `https://dev.azure.com/${org}/_apis/projects?api-version=7.1`;
        const listResponse = await fetch(listUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Basic ${authHeader}`,
          },
        });
        
        if (!listResponse.ok) {
          throw new Error(`Failed to get project ID: ${listResponse.statusText}`);
        }
        
        const projects = await listResponse.json();
        const project = projects.value?.find((p: any) => 
          p.name.toLowerCase() === projectName.toLowerCase() || p.id === projectName
        );
        
        if (!project) {
          throw new Error(`Project "${projectName}" not found in organization "${org}"`);
        }
        
        return project.id;
      }
      
      const project = await response.json();
      return project.id;
    } catch (error: any) {
      console.error(`❌ Error getting Azure DevOps project ID:`, error);
      throw new Error(`Failed to get project ID: ${error.message}`);
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
        
        // Parse repository name: could be "owner/repo" or just "repo"
        let owner = process.env.GITHUB_OWNER || '';
        let repo = repoName;
        
        if (repoName.includes('/')) {
          // Repository name is in format "owner/repo"
          const parts = repoName.split('/');
          owner = parts[0];
          repo = parts[1];
          console.log(`📦 Parsed repository for commit: owner=${owner}, repo=${repo}`);
        } else {
          // Just repo name, use owner from env
          console.log(`📦 Using repository for commit: owner=${owner} (from env), repo=${repo}`);
        }
        
        // Always use GitHub REST API for commits
        // REST API handles both create and update correctly
        // push_files doesn't support updating existing files
        console.log(`\n📤 Using GitHub REST API for commit`);
        console.log(`   Reason: REST API handles both create and update correctly`);
        console.log(`   push_files only works for new/empty repos`);
        console.log(`   Repository: ${owner}/${repo}`);
        console.log(`   Commit message: "${message}"`);
        console.log(`   Files to commit: ${files.length}`);
        files.forEach((f, i) => {
          console.log(`      ${i + 1}. ${f.path} (${f.content.length} chars)`);
        });
        
        return await this.commitFilesViaGitHubAPI(repo, files, message, owner);
        
        /* OLD LOGIC - Keeping for reference but not using
        // Check if repository has existing files
        // push_files only works for new/empty repos
        // For existing repos, use GitHub REST API (handles updates correctly)
        console.log(`\n🔍 Checking if repository has existing files...`);
        let hasExistingFiles = false;
        let scanSucceeded = false;
        
        try {
          const existingFiles = await this.scanRepositoryFiles(provider, repoName, 'main');
          hasExistingFiles = existingFiles.length > 0;
          scanSucceeded = true;
          console.log(`   ${hasExistingFiles ? `✅ Repository has ${existingFiles.length} existing file(s)` : `✅ Repository is empty (no files)`}`);
        } catch (scanError: any) {
          // If scan fails, default to REST API (safer)
          console.warn(`   ⚠️  Scan failed - defaulting to REST API (safer for updates)`);
          hasExistingFiles = true;
          scanSucceeded = false;
        }
        
        // Safety: If scan didn't succeed, always use REST API (handles both create and update)
        if (!scanSucceeded) {
          console.log(`   🔄 Scan did not succeed - using REST API (handles both create and update)`);
          hasExistingFiles = true;
        }
        
        // Decision: Use REST API for existing repos, push_files for empty repos
        if (hasExistingFiles) {
          console.log(`\n📤 Repository has existing files - using GitHub REST API`);
          console.log(`   Reason: push_files doesn't support updating existing files`);
          console.log(`   REST API handles both create and update correctly`);
          console.log(`   Repository: ${owner}/${repo}`);
          console.log(`   Commit message: "${message}"`);
          console.log(`   Files to commit: ${files.length}`);
          files.forEach((f, i) => {
            console.log(`      ${i + 1}. ${f.path} (${f.content.length} chars)`);
          });
          
          return await this.commitFilesViaGitHubAPI(repo, files, message, owner);
        } else {
          // Empty repository - use push_files (works for new repos)
          console.log(`\n📤 Repository is empty - using GitHub MCP push_files tool`);
          console.log(`   push_files works for creating initial commits`);
          console.log(`   Repository: ${owner}/${repo}`);
          console.log(`   Commit message: "${message}"`);
          console.log(`   Files to commit: ${files.length}`);
          files.forEach((f, i) => {
            console.log(`      ${i + 1}. ${f.path} (${f.content.length} chars)`);
          });
          
          // Use GitHub MCP server push_files tool for empty repos
          let branch = 'main';
          let result: any = null;
          
          // Try main branch first, then master
          for (const branchName of ['main', 'master']) {
            try {
              console.log(`\n📋 Attempting commit to branch: ${branchName}`);
              
              const pushParams = {
                owner: owner,
                repo: repo,
            files: files.map(f => ({
              path: f.path,
              content: f.content
            })),
                message: message,
                branch: branchName,
              };
              
              result = await this.callTool(provider, 'push_files', pushParams);
              branch = branchName;
              console.log(`✅ Successfully committed to branch: ${branchName} via push_files`);
              break; // Success, exit loop
            } catch (branchError: any) {
              const errorMsg = branchError.message || '';
              console.warn(`   ⚠️  Failed to commit to branch '${branchName}': ${errorMsg}`);
              
              // If it's a "not found" error, try other branch or fallback to REST API
              if (errorMsg.includes('Not Found') || errorMsg.includes('not found')) {
                // Try next branch, or fallback to REST API if both fail
                if (branchName === 'master') {
                  // Both branches failed, fallback to REST API
                  console.log(`\n⚠️  push_files failed for both branches - falling back to REST API`);
                  return await this.commitFilesViaGitHubAPI(repo, files, message, owner);
                }
                continue; // Try next branch
              } else {
                // Different error - throw immediately
                throw branchError;
              }
            }
          }
          
          if (!result) {
            // Fallback to REST API if push_files fails
            console.log(`\n⚠️  push_files failed - falling back to REST API`);
            return await this.commitFilesViaGitHubAPI(repo, files, message, owner);
          }
          
          // Parse MCP content parts
          if (result.content && Array.isArray(result.content)) {
            const textContent = result.content.find((item: any) => item.type === 'text');
            if (textContent && textContent.text) {
              try {
              const parsed = JSON.parse(textContent.text);
                console.log(`✅ Successfully committed to ${owner}/${repo} via GitHub MCP push_files`);
                console.log(`   Branch: ${branch}`);
                return { ...parsed, branch };
              } catch (parseError) {
                console.log(`✅ Successfully committed to ${owner}/${repo} via GitHub MCP push_files`);
                console.log(`   Branch: ${branch}`);
                return { success: true, message: textContent.text, branch };
              }
            }
          }
          
          console.log(`✅ Successfully committed to ${owner}/${repo} via GitHub MCP push_files`);
          return { success: true, result, branch };
        }
        */
      } else if (provider === 'azure') {
        // Azure DevOps - Use REST API directly (MCP doesn't support direct file commits)
        console.log(`📤 Committing ${files.length} files to Azure DevOps repository "${repoName}" via REST API...`);
        return await this.commitFilesViaAzureDevOpsAPI(repoName, files, message);
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }
    } catch (error: any) {
      // Error occurred - log and throw
      console.error(`\n❌ Error committing files for ${provider}:`, error);
      console.error(`   Error message: ${error?.message}`);
      console.error(`   Error code: ${error?.code}`);
      throw error;
    }
  }

  private async commitFilesViaGitHubAPI(
    repo: string,
    files: { path: string; content: string }[],
    message: string,
    owner: string
  ): Promise<any> {
    const octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });

    try {
      console.log(`\n📤 Committing ${files.length} file(s) via GitHub REST API...`);
      console.log(`   Repository: ${owner}/${repo}`);
      console.log(`   Commit message: "${message}"`);
      console.log(`   Method: createOrUpdateFileContents (handles both create and update)`);
      
      // Get file SHAs for existing files (required for updates)
      const fileSHAs = new Map<string, string>();
      const branch = 'main';
      
      for (const file of files) {
        try {
          const { data } = await octokit.rest.repos.getContent({
            owner,
            repo: repo,
            path: file.path,
            ref: branch,
          });
          
          if ('sha' in data && data.sha) {
            fileSHAs.set(file.path, data.sha);
            console.log(`   📄 ${file.path}: Existing file (SHA: ${data.sha.substring(0, 7)}...) - will UPDATE`);
          }
        } catch (error: any) {
          if (error.status === 404) {
            // File doesn't exist - will create new
            console.log(`   📄 ${file.path}: New file - will CREATE`);
          } else {
            console.warn(`   ⚠️  Could not check ${file.path}: ${error.message}`);
          }
        }
      }
      
      // Commit files one by one (REST API requires this)
      const results = [];
      for (const file of files) {
        const existingSHA = fileSHAs.get(file.path);
        const isUpdate = !!existingSHA;
        
        console.log(`\n   ${isUpdate ? '📝 Updating' : '➕ Creating'}: ${file.path}`);
        
        try {
        const result = await octokit.repos.createOrUpdateFileContents({
          owner,
            repo: repo,
          path: file.path,
            message: message, // Use same commit message for all files
          content: Buffer.from(file.content).toString('base64'),
            branch: branch,
            ...(isUpdate ? { sha: existingSHA } : {}), // Include SHA for updates
        });
          
        results.push(result.data);
          console.log(`   ✅ ${isUpdate ? 'Updated' : 'Created'} successfully`);
        } catch (fileError: any) {
          console.error(`   ❌ Failed to ${isUpdate ? 'update' : 'create'} ${file.path}: ${fileError.message}`);
          if (fileError.response?.data) {
            console.error(`   Error details:`, JSON.stringify(fileError.response.data, null, 2));
          }
          throw fileError;
        }
      }

      console.log(`\n✅ Successfully committed ${results.length} file(s) via GitHub REST API`);
      console.log(`   Method: createOrUpdateFileContents`);
      console.log(`   Branch: ${branch}`);
      
      // Get the commit SHA from the last file operation
      const lastResult = results[results.length - 1];
      const commitSha = lastResult?.commit?.sha || lastResult?.content?.sha || null;
      
      return {
        success: true,
        files: results,
        method: 'github-contents-api',
        branch: branch,
        commitSha: commitSha,
        updated: fileSHAs.size,
        created: files.length - fileSHAs.size
      };
    } catch (error: any) {
      console.error('\n❌ Error committing via GitHub REST API:');
      console.error('   Error:', error.message);
      if (error.response?.data) {
        console.error('   Error response:', JSON.stringify(error.response.data, null, 2));
      }
      throw new Error(`Failed to commit via GitHub REST API: ${error.message}`);
    }
  }

  async scanRepositoryFiles(
    provider: MCPProvider,
    repoName: string,
    branch: string = 'main',
    credentials?: RepositoryCredentials
  ): Promise<{ path: string; content: string }[]> {
    try {
      if (provider === 'github') {
        const octokit = new Octokit({
          auth: credentials?.github?.token || process.env.GITHUB_TOKEN,
        });

        // Parse repository name: could be "owner/repo" or just "repo"
        let owner = credentials?.github?.owner || process.env.GITHUB_OWNER || '';
        let repo = repoName;
        
        if (repoName.includes('/')) {
          // Repository name is in format "owner/repo"
          const parts = repoName.split('/');
          owner = parts[0];
          repo = parts[1];
          console.log(`📦 Parsed repository: owner=${owner}, repo=${repo}`);
        } else {
          // Just repo name, use owner from env
          console.log(`📦 Using repository: owner=${owner} (from env), repo=${repo}`);
        }

        try {
          // Get the branch reference first to get the commit SHA
          let commitSha = branch;
          try {
            const refResult = await this.withRetry(() =>
              octokit.rest.git.getRef({ owner, repo: repo, ref: `heads/${branch}` })
            );
            commitSha = refResult.data.object.sha;
            console.log(`   Branch '${branch}' points to commit: ${commitSha.substring(0, 7)}...`);
          } catch (refError: any) {
            // If branch ref doesn't exist, try using branch name directly as SHA (might work)
            console.warn(`   ⚠️  Could not get branch ref for '${branch}': ${refError.message}`);
            // Will try branch name as SHA below
          }

          const { data: tree } = await this.withRetry(() =>
            octokit.rest.git.getTree({ owner, repo: repo, tree_sha: commitSha, recursive: 'true' })
          );

          // CRITICAL: Include both .tf and .tfvars files (not just .tf)
          const tfFiles = tree.tree.filter(
            (item) => (item.path?.endsWith('.tf') || item.path?.endsWith('.tfvars')) && item.type === 'blob'
          );

          const fileContents = await Promise.all(
            tfFiles.map(async (file) => {
              if (!file.path) return null;

              try {
                const { data } = await this.withRetry(() =>
                  octokit.rest.repos.getContent({ owner, repo: repo, path: file.path!, ref: branch })
                );

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
            console.log(`Repository ${owner}/${repo} is empty`);
            return [];
          }
          console.error(`Error fetching repository tree for ${owner}/${repo}:`, error.message);
          throw error;
        }
      } else if (provider === 'azure') {
        // Azure DevOps - Use REST API directly (MCP doesn't support file content reading)
        console.log(`📖 Scanning Azure DevOps repository "${repoName}" via REST API...`);
        return await this.scanRepositoryFilesViaAzureDevOpsAPI(repoName, branch, credentials);
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }
    } catch (error) {
      console.error(`Error scanning repository ${repoName}:`, error);
      throw error;
    }
  }

  private parseGitHubRepoName(repoName: string, credentials?: RepositoryCredentials): { owner: string; repo: string } {
    let owner = credentials?.github?.owner || process.env.GITHUB_OWNER || '';
    let repo = repoName;
    if (repoName.includes('/')) {
      const parts = repoName.split('/');
      owner = parts[0];
      repo = parts[1];
    }
    if (!owner || !repo) {
      throw new Error('Unable to resolve GitHub repository owner or name.');
    }
    return { owner, repo };
  }

  private async resolveGitHubCommitSha(
    octokit: Octokit,
    owner: string,
    repo: string,
    branch: string
  ): Promise<string> {
    try {
      const { data: ref } = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      });
      return ref.object.sha;
    } catch (error: any) {
      console.warn(`   ⚠️  Could not resolve branch '${branch}': ${error.message}`);
      return branch;
    }
  }

  async listRepositoryPaths(
    provider: MCPProvider,
    repoName: string,
    branch: string = 'main',
    credentials?: RepositoryCredentials
  ): Promise<string[]> {
    if (provider === 'github') {
      const octokit = new Octokit({
        auth: credentials?.github?.token || process.env.GITHUB_TOKEN,
      });
      const { owner, repo } = this.parseGitHubRepoName(repoName, credentials);
      const commitSha = await this.resolveGitHubCommitSha(octokit, owner, repo, branch);
      try {
        const { data: treeData } = await octokit.rest.git.getTree({
          owner,
          repo,
          tree_sha: commitSha,
          recursive: 'true',
        });
        return (treeData.tree || [])
          .filter((item) => item.type === 'blob' && item.path)
          .map((item) => item.path || '')
          .filter(Boolean);
      } catch (error: any) {
        if (error.status === 409 || error.message?.includes("Git Repository is empty")) {
          console.log(`Repository ${owner}/${repo} is empty`);
          return [];
        }
        console.error(`Error fetching repository tree for ${owner}/${repo}:`, error.message || error);
        throw error;
      }
    } else if (provider === 'azure') {
      // List ALL file paths (not just .tf) — used by Docker, ArchMe, etc.
      const org = credentials?.azure?.org || process.env.AZURE_DEVOPS_ORG;
      const pat = credentials?.azure?.pat || process.env.AZURE_DEVOPS_PAT;
      const project = credentials?.azure?.project || process.env.AZURE_DEVOPS_PROJECT;
      if (!org || !pat || !project) {
        throw new Error('Azure DevOps credentials not configured.');
      }
      const repoId = await this.getAzureDevOpsRepositoryId(org, pat, project, repoName);
      const itemsUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repoId}/items?recursionLevel=Full&versionDescriptor.version=${branch}&versionDescriptor.versionType=branch&api-version=7.1`;
      const authHeader = Buffer.from(`:${pat}`).toString('base64');
      const response = await fetch(itemsUrl, {
        headers: { 'Authorization': `Basic ${authHeader}` },
      });
      if (!response.ok) {
        if (response.status === 404) return [];
        throw new Error(`Failed to fetch repository items: ${response.statusText}`);
      }
      const items = await response.json();
      const allFiles = (items.value || []) as any[];
      return allFiles
        .filter((item: any) => item.isFolder === false || item.gitObjectType === 'blob')
        .map((item: any) => item.path || '')
        .filter(Boolean);
    }
    throw new Error(`Unsupported provider: ${provider}`);
  }

  async getRepositoryFile(
    provider: MCPProvider,
    repoName: string,
    filePath: string,
    branch: string = 'main',
    credentials?: RepositoryCredentials
  ): Promise<{ path: string; content: string }> {
    if (provider === 'github') {
      const octokit = new Octokit({
        auth: credentials?.github?.token || process.env.GITHUB_TOKEN,
      });
      const { owner, repo } = this.parseGitHubRepoName(repoName, credentials);
      const response = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: branch,
      });
      if (Array.isArray(response.data)) {
        throw new Error(`Expected file but got directory for path: ${filePath}`);
      }
      const data = response.data as { content?: string };
      if (!data.content) {
        throw new Error(`File ${filePath} has no content`);
      }
      return {
        path: filePath,
        content: Buffer.from(data.content, 'base64').toString('utf-8'),
      };
    } else if (provider === 'azure') {
      const org = credentials?.azure?.org || process.env.AZURE_DEVOPS_ORG;
      const pat = credentials?.azure?.pat || process.env.AZURE_DEVOPS_PAT;
      const project = credentials?.azure?.project || process.env.AZURE_DEVOPS_PROJECT;
      if (!org || !pat || !project) {
        throw new Error('Azure DevOps credentials not configured.');
      }
      const repoId = await this.getAzureDevOpsRepositoryId(org, pat, project, repoName);
      const authHeader = Buffer.from(`:${pat}`).toString('base64');
      const targetPath = filePath.startsWith('/') ? filePath : `/${filePath}`;
      const url = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent(
        targetPath
      )}&versionDescriptor.version=${branch}&versionDescriptor.versionType=branch&api-version=7.1&$format=text`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Basic ${authHeader}`,
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to download file ${filePath}: ${response.statusText}`);
      }
      const content = await response.text();
      return {
        path: filePath,
        content,
      };
    }
    throw new Error(`Unsupported provider: ${provider}`);
  }

  /**
   * Commit files to Azure DevOps repository via REST API
   */
  private async commitFilesViaAzureDevOpsAPI(
    repoName: string,
    files: { path: string; content: string }[],
    message: string
  ): Promise<any> {
    try {
      const org = process.env.AZURE_DEVOPS_ORG;
      const pat = process.env.AZURE_DEVOPS_PAT;
      const project = process.env.AZURE_DEVOPS_PROJECT;
      
      if (!org || !pat || !project) {
        throw new Error('Azure DevOps credentials not configured. Please set AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT, and AZURE_DEVOPS_PROJECT environment variables.');
      }
      
      // Get repository ID
      const repoId = await this.getAzureDevOpsRepositoryId(org, pat, project, repoName);
      
      // Get default branch and latest commit
      const branchInfo = await this.getAzureDevOpsBranchInfo(org, pat, project, repoId);
      const branchName = branchInfo.name || 'main';
      const baseCommitId = branchInfo.commitId;
      
      console.log(`   Repository ID: ${repoId}`);
      console.log(`   Branch: ${branchName}`);
      console.log(`   Base commit: ${baseCommitId}`);
      console.log(`   Files to commit: ${files.length}`);
      
      // Create changes (additions/edits)
      const changes = files.map(file => ({
        changeType: 'edit', // Will be determined by checking if file exists
        item: {
          path: file.path
        },
        newContent: {
          content: Buffer.from(file.content).toString('base64'),
          contentType: 'base64encoded'
        }
      }));
      
      // Check which files exist and update changeType accordingly
      for (let i = 0; i < changes.length; i++) {
        const file = files[i];
        try {
          // Try to get file to see if it exists
          const fileUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent(file.path)}&versionDescriptor.version=${branchName}&versionDescriptor.versionType=branch&api-version=7.1`;
          const authHeader = Buffer.from(`:${pat}`).toString('base64');
          
          const fileResponse = await fetch(fileUrl, {
            method: 'GET',
            headers: {
              'Authorization': `Basic ${authHeader}`,
            },
          });
          
          if (fileResponse.ok) {
            changes[i].changeType = 'edit';
            console.log(`   📝 ${file.path} - will be updated`);
          } else {
            changes[i].changeType = 'add';
            console.log(`   ➕ ${file.path} - will be created`);
          }
        } catch {
          // If check fails, assume it's a new file
          changes[i].changeType = 'add';
          console.log(`   ➕ ${file.path} - will be created (existence check failed)`);
        }
      }
      
      // Create commit via REST API
      const commitUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repoId}/pushes?api-version=7.1`;
      const authHeader = Buffer.from(`:${pat}`).toString('base64');
      
      const pushBody = {
        refUpdates: [{
          name: `refs/heads/${branchName}`,
          oldObjectId: baseCommitId
        }],
        commits: [{
          comment: message,
          changes: changes
        }]
      };
      
      console.log(`📤 Creating commit via Azure DevOps REST API...`);
      
      const response = await fetch(commitUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${authHeader}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(pushBody),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Azure DevOps API error: ${response.status} ${response.statusText}`);
        console.error(`   Response: ${errorText}`);
        throw new Error(`Failed to commit files: ${response.statusText}. ${errorText}`);
      }
      
      const result = await response.json();
      const commitId = result.commits?.[0]?.commitId || result.refUpdates?.[0]?.newObjectId;
      
      console.log(`✅ Successfully committed ${files.length} file(s) via Azure DevOps REST API`);
      console.log(`   Commit ID: ${commitId}`);
      console.log(`   Branch: ${branchName}`);
      
      return {
        success: true,
        commitSha: commitId,
        branch: branchName,
        method: 'azure-devops-rest-api',
        message: `Successfully committed ${files.length} file(s) to ${repoName}`
      };
    } catch (error: any) {
      console.error(`❌ Error committing files via Azure DevOps REST API:`, error);
      throw error;
    }
  }
  
  /**
   * Get Azure DevOps repository ID by repository name
   */
  private async getAzureDevOpsRepositoryId(org: string, pat: string, project: string, repoName: string): Promise<string> {
    try {
      const apiUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${encodeURIComponent(repoName)}?api-version=7.1`;
      const authHeader = Buffer.from(`:${pat}`).toString('base64');
      
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${authHeader}`,
        },
      });
      
      if (!response.ok) {
        // If direct lookup fails, try listing all repos
        const listUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories?api-version=7.1`;
        const listResponse = await fetch(listUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Basic ${authHeader}`,
          },
        });
        
        if (!listResponse.ok) {
          throw new Error(`Failed to get repository ID: ${listResponse.statusText}`);
        }
        
        const repos = await listResponse.json();
        const repo = repos.value?.find((r: any) => 
          r.name.toLowerCase() === repoName.toLowerCase() || r.id === repoName
        );
        
        if (!repo) {
          throw new Error(`Repository "${repoName}" not found in project "${project}"`);
        }
        
        return repo.id;
      }
      
      const repo = await response.json();
      return repo.id;
    } catch (error: any) {
      console.error(`❌ Error getting Azure DevOps repository ID:`, error);
      throw new Error(`Failed to get repository ID: ${error.message}`);
    }
  }
  
  /**
   * Get Azure DevOps branch information (name and latest commit ID)
   */
  private async getAzureDevOpsBranchInfo(org: string, pat: string, project: string, repoId: string): Promise<{ name: string; commitId: string }> {
    try {
      // Try main branch first, then master
      for (const branchName of ['main', 'master']) {
        try {
          const apiUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repoId}/refs?filter=heads/${branchName}&api-version=7.1`;
          const authHeader = Buffer.from(`:${pat}`).toString('base64');
          
          const response = await fetch(apiUrl, {
            method: 'GET',
            headers: {
              'Authorization': `Basic ${authHeader}`,
            },
          });
          
          if (response.ok) {
            const data = await response.json();
            const ref = data.value?.[0];
            if (ref && ref.objectId) {
              return { name: branchName, commitId: ref.objectId };
            }
          }
        } catch {
          // Try next branch
          continue;
        }
      }
      
      // If no branch found, create initial commit (empty repository)
      // Return a zero commit ID which will create a new branch
      return { name: 'main', commitId: '0000000000000000000000000000000000000000' };
    } catch (error: any) {
      console.error(`❌ Error getting Azure DevOps branch info:`, error);
      // Default to main with zero commit (new branch)
      return { name: 'main', commitId: '0000000000000000000000000000000000000000' };
    }
  }

  /**
   * Scan Azure DevOps repository files via REST API
   */
  private async scanRepositoryFilesViaAzureDevOpsAPI(
    repoName: string,
    branch: string = 'main',
    credentials?: RepositoryCredentials
  ): Promise<Array<{ path: string; content: string }>> {
    try {
      const org = credentials?.azure?.org || process.env.AZURE_DEVOPS_ORG;
      const pat = credentials?.azure?.pat || process.env.AZURE_DEVOPS_PAT;
      const project = credentials?.azure?.project || process.env.AZURE_DEVOPS_PROJECT;

      if (!org || !pat || !project) {
        throw new Error('Azure DevOps credentials not configured. Please set AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT, and AZURE_DEVOPS_PROJECT environment variables.');
      }
      
      // Get repository ID
      const repoId = await this.getAzureDevOpsRepositoryId(org, pat, project, repoName);
      
      // Get items (files) from repository
      const itemsUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repoId}/items?recursionLevel=Full&versionDescriptor.version=${branch}&versionDescriptor.versionType=branch&api-version=7.1`;
      const authHeader = Buffer.from(`:${pat}`).toString('base64');
      
      console.log(`   Fetching files from branch: ${branch}`);
      
      const response = await fetch(itemsUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${authHeader}`,
        },
      });
      
      if (!response.ok) {
        if (response.status === 404) {
          console.log(`   Repository or branch not found - returning empty list`);
          return [];
        }
        throw new Error(`Failed to fetch repository items: ${response.statusText}`);
      }
      
      const items = await response.json();
      const files = items.value || [];
      
      // Filter for .tf and .tfvars files
      // Note: Azure DevOps returns isFolder as undefined for files, use gitObjectType instead
      const tfFiles = files.filter((item: any) => {
        const path = item.path || '';
        const isTerraformFile = path.endsWith('.tf') || path.endsWith('.tfvars');
        // Azure DevOps uses gitObjectType: 'blob' for files, 'tree' for folders
        // isFolder might be undefined, so check gitObjectType
        const isNotFolder = item.isFolder === false || item.gitObjectType === 'blob' || item.isFolder !== true;
        return isTerraformFile && isNotFolder;
      });
      
      console.log(`   Found ${tfFiles.length} Terraform file(s)`);
      
      // Fetch content for each file
      const fileContents: Array<{ path: string; content: string }> = [];
      
      for (const file of tfFiles) {
        try {
          const contentUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent(file.path)}&versionDescriptor.version=${branch}&versionDescriptor.versionType=branch&api-version=7.1`;
          
          const contentResponse = await fetch(contentUrl, {
            method: 'GET',
            headers: {
              'Authorization': `Basic ${authHeader}`,
            },
          });
          
          if (contentResponse.ok) {
            const content = await contentResponse.text();
            fileContents.push({
              path: file.path,
              content: content
            });
            console.log(`   ✅ Fetched: ${file.path}`);
          } else {
            console.warn(`   ⚠️  Failed to fetch content for ${file.path}: ${contentResponse.statusText}`);
          }
        } catch (error: any) {
          console.warn(`   ⚠️  Error fetching content for ${file.path}: ${error.message}`);
        }
      }
      
      console.log(`✅ Successfully scanned ${fileContents.length} file(s) from Azure DevOps repository`);
      return fileContents;
    } catch (error: any) {
      console.error(`❌ Error scanning Azure DevOps repository:`, error);
      throw error;
    }
  }

  /**
   * List Azure DevOps repositories via REST API
   */
  private async listRepositoriesViaAzureDevOpsAPI(): Promise<any[]> {
    try {
      const org = process.env.AZURE_DEVOPS_ORG;
      const pat = process.env.AZURE_DEVOPS_PAT;
      const project = process.env.AZURE_DEVOPS_PROJECT;
      
      if (!org || !pat || !project) {
        throw new Error('Azure DevOps credentials not configured. Please set AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT, and AZURE_DEVOPS_PROJECT environment variables.');
      }
      
      console.log(`📡 [Azure DevOps REST API] Starting repository fetch...`);
      console.log(`   Organization: ${org}`);
      console.log(`   Project: ${project}`);
      
      // Get project ID first (needed for some API calls)
      let projectId: string;
      try {
        projectId = await this.getAzureDevOpsProjectId(org, pat, project);
        console.log(`   Project ID: ${projectId}`);
      } catch (projectError: any) {
        console.warn(`⚠️  [Azure DevOps REST API] Could not get project ID: ${projectError.message}`);
        console.warn(`   Continuing with project name instead...`);
        projectId = project;
      }
      
      // List repositories via REST API
      const apiUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories?api-version=7.1`;
      const authHeader = Buffer.from(`:${pat}`).toString('base64');
      
      console.log(`📡 [Azure DevOps REST API] Fetching repositories from: ${apiUrl}`);
      
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${authHeader}`,
        },
      });
      
      console.log(`📥 [Azure DevOps REST API] Response status: ${response.status} ${response.statusText}`);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ [Azure DevOps REST API] Error: ${response.status} ${response.statusText}`);
        console.error(`   Response: ${errorText}`);
        
        if (response.status === 401 || response.status === 403) {
          throw new Error('Azure DevOps authentication failed. Please check your PAT permissions (Code > Read).');
        } else if (response.status === 404) {
          throw new Error(`Project "${project}" not found in organization "${org}".`);
        } else {
          throw new Error(`Failed to list repositories: ${response.statusText}. ${errorText}`);
        }
      }
      
      const data = await response.json();
      console.log(`📊 [Azure DevOps REST API] Response data keys: ${Object.keys(data).join(', ')}`);
      console.log(`📊 [Azure DevOps REST API] Response data.value type: ${Array.isArray(data.value) ? 'array' : typeof data.value}`);
      console.log(`📊 [Azure DevOps REST API] Response data.value length: ${data.value?.length || 0}`);
      
      const repos = data.value || [];
      
      if (repos.length === 0) {
        console.warn(`⚠️  [Azure DevOps REST API] No repositories found in project "${project}"`);
        console.warn(`   This could mean:`);
        console.warn(`   1. The project has no Git repositories`);
        console.warn(`   2. The PAT doesn't have permission to read repositories`);
        console.warn(`   3. The project name is incorrect`);
        return [];
      }
      
      console.log(`✅ [Azure DevOps REST API] Found ${repos.length} repository/repositories`);
      
      // Format repositories to match expected structure
      const formattedRepos = repos.map((repo: any, index: number) => {
        const formatted = {
          id: String(repo.id || ''),
          name: repo.name || '',
          defaultBranch: repo.defaultBranch || 'main',
          url: repo.url || repo.remoteUrl || repo.webUrl || '',
          lastUpdated: repo.updatedDate || repo.lastUpdateTime || '',
          project: {
            id: projectId,
            name: project
          }
        };
        console.log(`   📦 REST API Repo ${index + 1}: ${formatted.name} (ID: ${formatted.id})`);
        return formatted;
      });
      
      console.log(`✅ [Azure DevOps REST API] Returning ${formattedRepos.length} formatted repository/repositories`);
      return formattedRepos;
    } catch (error: any) {
      console.error(`❌ [Azure DevOps REST API] Error listing repositories:`, error);
      console.error(`   Error message: ${error.message}`);
      console.error(`   Error stack: ${error.stack}`);
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
      let client;
      try {
        client = await this.getClient('azure', 'resources');
      } catch (mcpError: any) {
        const errorMsg = mcpError.message || String(mcpError);
        if (errorMsg.includes('MCP server connection failed') || 
            errorMsg.includes('Connection closed') ||
            errorMsg.includes('-32000')) {
          throw new Error(`Azure MCP server is not available. Please ensure:
1. Azure MCP server is installed: npx -y @azure/mcp@latest
2. Azure credentials are configured (Service Principal, Managed Identity, or Azure CLI)
3. Check server logs for connection errors

Original error: ${errorMsg}`);
        }
        throw mcpError;
      }
      
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
      let client;
      try {
        client = await this.getClient('azure', 'resources');
      } catch (mcpError: any) {
        const errorMsg = mcpError.message || String(mcpError);
        if (errorMsg.includes('MCP server connection failed') || 
            errorMsg.includes('Connection closed') ||
            errorMsg.includes('-32000')) {
          throw new Error(`Azure MCP server is not available. Please ensure:
1. Azure MCP server is installed: npx -y @azure/mcp@latest
2. Azure credentials are configured (Service Principal, Managed Identity, or Azure CLI)
3. Check server logs for connection errors

Original error: ${errorMsg}`);
        }
        throw mcpError;
      }
      
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
      let client;
      try {
        client = await this.getClient('azure', 'resources');
      } catch (mcpError: any) {
        const errorMsg = mcpError.message || String(mcpError);
        if (errorMsg.includes('MCP server connection failed') || 
            errorMsg.includes('Connection closed') ||
            errorMsg.includes('-32000')) {
          return {
            success: false,
            error: `Azure MCP server is not available. Please ensure:
1. Azure MCP server is installed: npx -y @azure/mcp@latest
2. Azure credentials are configured (Service Principal, Managed Identity, or Azure CLI)
3. Check server logs for connection errors

Original error: ${errorMsg}`
          };
        }
        throw mcpError;
      }
      
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
      let client;
      try {
        client = await this.getClient('azure', 'resources');
      } catch (mcpError: any) {
        const errorMsg = mcpError.message || String(mcpError);
        if (errorMsg.includes('MCP server connection failed') || 
            errorMsg.includes('Connection closed') ||
            errorMsg.includes('-32000')) {
          throw new Error(`Azure MCP server is not available. Please ensure:
1. Azure MCP server is installed: npx -y @azure/mcp@latest
2. Azure credentials are configured (Service Principal, Managed Identity, or Azure CLI)
3. Check server logs for connection errors

Original error: ${errorMsg}`);
        }
        throw mcpError;
      }
      
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
      let client;
      try {
        client = await this.getClient('azure', 'resources');
      } catch (mcpError: any) {
        const errorMsg = mcpError.message || String(mcpError);
        if (errorMsg.includes('MCP server connection failed') || 
            errorMsg.includes('Connection closed') ||
            errorMsg.includes('-32000')) {
          return {
            success: false,
            error: `Azure MCP server is not available. Please ensure:
1. Azure MCP server is installed: npx -y @azure/mcp@latest
2. Azure credentials are configured (Service Principal, Managed Identity, or Azure CLI)
3. Check server logs for connection errors

Original error: ${errorMsg}`
          };
        }
        throw mcpError;
      }
      
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
      let client;
      try {
        client = await this.getClient('azure', 'resources');
      } catch (mcpError: any) {
        const errorMsg = mcpError.message || String(mcpError);
        if (errorMsg.includes('MCP server connection failed') || 
            errorMsg.includes('Connection closed') ||
            errorMsg.includes('-32000')) {
          return {
            success: false,
            error: `Azure MCP server is not available. Please ensure:
1. Azure MCP server is installed: npx -y @azure/mcp@latest
2. Azure credentials are configured (Service Principal, Managed Identity, or Azure CLI)
3. Check server logs for connection errors

Original error: ${errorMsg}`
          };
        }
        throw mcpError;
      }
      
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

  // Verify Service Principal permissions by testing Azure access
  // This is a simple check - we test if the Service Principal can access Azure
  // Role assignment is a CLI task that should be done by administrators manually
  // Note: If MCP connection fails, we skip the check and proceed (actual operations will fail with clearer errors)
  async ensureServicePrincipalRoles(): Promise<{
    success: boolean;
    message: string;
    skipped?: boolean;
  }> {
    try {
      // Check if Service Principal credentials are configured
      if (!process.env.AZURE_CLIENT_ID || !process.env.AZURE_SUBSCRIPTION_ID || !process.env.AZURE_TENANT_ID) {
        return {
          success: false,
          message: 'Azure Cloud credentials not configured. Please save your Azure Service Principal credentials in Settings → Azure Cloud, or set AZURE_CLIENT_ID, AZURE_TENANT_ID, and AZURE_SUBSCRIPTION_ID as environment variables in your deployment.'
        };
      }

      const clientId = process.env.AZURE_CLIENT_ID;
      const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;

      console.log('🔍 Verifying Service Principal permissions...');
      console.log(`Service Principal (Client ID): ${clientId}`);
      console.log(`Subscription: ${subscriptionId}`);

      // Test Azure access by attempting to list resource groups
      // This is the simplest way to verify permissions
      try {
        const client = await this.getClient('azure', 'resources');
        await client.callTool({
          name: 'azure_list_resource_groups',
          arguments: {}
        });
        console.log('✅ Service Principal has Azure access and required permissions');
        
        return {
          success: true,
          message: '✅ Service Principal permissions verified. Ready to create Azure resources.'
        };
      } catch (error: any) {
        const errorMessage = error.message || '';
        
        // If it's a connection/MCP error, skip the check and proceed
        // The actual resource creation will fail with a clearer error if permissions are missing
        if (errorMessage.includes('MCP server connection failed') || 
            errorMessage.includes('Connection closed') ||
            errorMessage.includes('ENOENT') ||
            errorMessage.includes('spawn')) {
          console.warn('⚠️ MCP server connection issue during permission check. Will proceed and verify during actual resource creation.');
          return {
            success: true,
            message: '⚠️ Could not verify permissions (MCP connection issue). Will attempt resource creation and verify permissions then.',
            skipped: true
          };
        }
        
        // If it's an authentication/permission error, provide helpful instructions
        if (errorMessage.includes('Authentication') || 
            errorMessage.includes('401') || 
            errorMessage.includes('403') ||
            errorMessage.includes('Authorization') ||
            errorMessage.includes('permission')) {
          return {
            success: false,
            message: `❌ Service Principal does not have required permissions.

The Service Principal needs the following roles assigned at the subscription level:
   - Contributor (covers resource group creation)
   - Storage Account Contributor
   - Storage Blob Data Contributor

📋 To assign roles (run as an administrator with proper permissions):
   # Get Service Principal Object ID (NOT the App ID/Client ID)
   SP_OBJECT_ID=$(az ad sp show --id ${clientId} --query id -o tsv)
   
   # Assign roles using the Object ID
   az role assignment create --assignee $SP_OBJECT_ID --role "Contributor" --scope /subscriptions/${subscriptionId}
   az role assignment create --assignee $SP_OBJECT_ID --role "Storage Account Contributor" --scope /subscriptions/${subscriptionId}
   az role assignment create --assignee $SP_OBJECT_ID --role "Storage Blob Data Contributor" --scope /subscriptions/${subscriptionId}

⚠️ Important: Use Service Principal Object ID (NOT App ID/Client ID) for role assignment!
   - App ID (Client ID): ${clientId} (this is what's in your .env file)
   - Object ID: Run 'az ad sp show --id ${clientId} --query id -o tsv' to get it

🔐 Security Note: Role assignment requires 'User Access Administrator' or 'Owner' role.
   This should be done by an Azure administrator, not automatically by the application.

⏱️ After assigning roles, wait 2-3 minutes for permissions to propagate, then try again.`
          };
        }
        
        // For other errors, log but don't block - let actual operations fail with clearer errors
        console.warn('⚠️ Permission check failed with unexpected error:', errorMessage);
        return {
          success: true,
          message: '⚠️ Could not verify permissions. Will attempt resource creation and verify permissions then.',
          skipped: true
        };
      }
    } catch (error: any) {
      // If there's an unexpected error, don't block - proceed and let actual operations fail
      console.warn('⚠️ Error during permission check, proceeding anyway:', error.message);
      return {
        success: true,
        message: '⚠️ Could not verify permissions. Will attempt resource creation and verify permissions then.',
        skipped: true
      };
    }
  }


  // Get latest Terraform version from Terraform MCP server or fallback to GitHub API
  async getLatestTerraformVersion(): Promise<string> {
    try {
      // Try Terraform MCP server first
      try {
        const config = this.getConfig('terraform');
        console.log(`🔍 Attempting to connect to Terraform MCP server...`);
        console.log(`   Command: ${config.command} ${config.args.join(' ')}`);
        
        const client = await this.getClient('terraform');
        const tools = await client.listTools();
        
        console.log(`✅ Connected to Terraform MCP server`);
        console.log(`   Available tools: ${tools.tools?.length || 0}`);
        
        // Look for a version tool
        const versionTool = tools.tools?.find((tool: any) => 
          tool.name?.includes('version') || tool.name?.includes('latest')
        );
        
        if (versionTool) {
          console.log(`   Using tool: ${versionTool.name}`);
          const result = await client.callTool({
            name: versionTool.name,
            arguments: {}
          });
          
          if (result.content && Array.isArray(result.content) && result.content.length > 0) {
            const firstContent = result.content[0] as { text?: string };
            if (firstContent?.text) {
              const version = firstContent.text.trim();
              // Extract version number (e.g., "1.9.0" from "Terraform 1.9.0")
              const versionMatch = version.match(/(\d+\.\d+\.\d+)/);
              if (versionMatch) {
                console.log(`   ✅ Got version from MCP: ${versionMatch[1]}`);
                return versionMatch[1];
              }
            }
          }
        } else {
          console.log(`   ⚠️  No version tool found in MCP server`);
        }
      } catch (mcpError: any) {
        const errorMsg = mcpError?.message || String(mcpError);
        
        // Don't log as error if it's just a connection issue - we have fallback
        if (errorMsg.includes('Connection closed') || errorMsg.includes('-32000') || errorMsg.includes('MCP server connection failed')) {
          console.log(`⚠️  Terraform MCP server not available (connection issue). Using GitHub API fallback...`);
          console.log(`   Package: terraform-mcp-server (published by thrashr888)`);
        } else {
          console.log(`⚠️  Terraform MCP server not available for version: ${errorMsg}`);
          console.log(`   Falling back to GitHub API for version information...`);
        }
      }
      
      // Fallback: Use GitHub Releases API (this is fine - version fetching is separate from code generation)
      const response = await fetch('https://api.github.com/repos/hashicorp/terraform/releases/latest', {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'AICloudBuilder'
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        // Extract version from tag (e.g., "v1.9.0" -> "1.9.0")
        const version = data.tag_name?.replace(/^v/, '') || '1.9.0';
        console.log(`   ✅ Got version from GitHub API: ${version}`);
        return version;
      }
    } catch (error) {
      console.error('❌ Error fetching Terraform version:', error);
    }
    
    // Final fallback: return a reasonable default
    console.log(`   ⚠️  Using default Terraform version: 1.9.0`);
    return '1.9.0';
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
