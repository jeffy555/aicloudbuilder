/**
 * Debug/Development API routes
 * These endpoints are for development and testing purposes
 */

import type { Express } from "express";
import { mcpClient, type MCPProvider } from "../mcp-client";
import { bitwardenService, isBitwardenConfigured } from "../services/bitwarden-service";
import { optionalAuth, type AuthenticatedRequest } from "../middleware/auth";

/**
 * Register debug routes
 */
export function registerDebugRoutes(app: Express) {
  // Test Azure MCP server connection (resources)
  app.get("/api/debug/azure-mcp", async (req, res) => {
    try {
      console.log('🧪 Testing Azure MCP server connection (resources)...');
      
      const testResults: any = {
        timestamp: new Date().toISOString(),
        tests: [],
        environment: {
          AZURE_CLIENT_ID: process.env.AZURE_CLIENT_ID ? '***' : 'NOT SET',
          AZURE_TENANT_ID: process.env.AZURE_TENANT_ID ? '***' : 'NOT SET',
          AZURE_SUBSCRIPTION_ID: process.env.AZURE_SUBSCRIPTION_ID ? '***' : 'NOT SET',
          AZURE_CLIENT_SECRET: process.env.AZURE_CLIENT_SECRET ? 'SET' : 'NOT SET',
          AZURE_CLIENT_CERTIFICATE_PATH: process.env.AZURE_CLIENT_CERTIFICATE_PATH || 'NOT SET',
          AZURE_FEDERATED_TOKEN_FILE: process.env.AZURE_FEDERATED_TOKEN_FILE || 'NOT SET',
        }
      };
      
      // Test 1: Check package availability
      testResults.tests.push({
        name: 'Package availability check',
        status: 'info',
        message: 'Package: @azure/mcp@latest (will be downloaded via npx)'
      });
      
      // Test 2: Try to get client
      try {
        const client = await mcpClient.getClient('azure', 'resources');
        testResults.tests.push({
          name: 'MCP client connection',
          status: 'success',
          message: 'Successfully connected to Azure MCP server'
        });
        
        // Test 3: List tools
        try {
          const tools = await client.listTools();
          testResults.tests.push({
            name: 'List tools',
            status: 'success',
            message: `Found ${tools.tools?.length || 0} tools`,
            tools: tools.tools?.map((t: any) => t.name) || []
          });
        } catch (toolError: any) {
          testResults.tests.push({
            name: 'List tools',
            status: 'error',
            message: toolError.message || 'Failed to list tools'
          });
        }
        
      } catch (clientError: any) {
        testResults.tests.push({
          name: 'MCP client connection',
          status: 'error',
          message: clientError.message || 'Failed to connect to Azure MCP server',
          error: clientError.toString()
        });
      }
      
      res.json(testResults);
    } catch (error: any) {
      console.error('Error testing Azure MCP:', error);
      res.status(500).json({ 
        error: 'Failed to test Azure MCP server',
        details: error.message 
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

  // Credential diagnostic endpoint — use this in production to diagnose why Bitwarden isn't working
  app.get("/api/debug/credentials", optionalAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.userId;
      const providers = ['github', 'azure-devops', 'azure-cloud'] as const;

      const envCheck = {
        BITWARDEN_ACCESS_TOKEN: process.env.BITWARDEN_ACCESS_TOKEN ? '✅ SET' : '❌ NOT SET',
        BITWARDEN_PROJECT_ID: process.env.BITWARDEN_PROJECT_ID ? '✅ SET' : '❌ NOT SET',
        GITHUB_TOKEN: process.env.GITHUB_TOKEN ? '✅ SET (env fallback)' : '❌ NOT SET',
        GITHUB_OWNER: process.env.GITHUB_OWNER ? '✅ SET (env fallback)' : '❌ NOT SET',
        AZURE_DEVOPS_ORG: process.env.AZURE_DEVOPS_ORG ? '✅ SET (env fallback)' : '❌ NOT SET',
        AZURE_DEVOPS_PAT: process.env.AZURE_DEVOPS_PAT ? '✅ SET (env fallback)' : '❌ NOT SET',
        AZURE_DEVOPS_PROJECT: process.env.AZURE_DEVOPS_PROJECT ? '✅ SET (env fallback)' : '❌ NOT SET',
        JWT_SECRET: process.env.JWT_SECRET ? '✅ SET' : '❌ NOT SET (using dev fallback)',
        NODE_ENV: process.env.NODE_ENV || 'not set',
      };

      const authStatus = userId
        ? `✅ Authenticated — userId: ${userId}`
        : '❌ Not authenticated — no valid JWT token in request';

      const bitwardenStatus = isBitwardenConfigured()
        ? '✅ Configured (ACCESS_TOKEN + PROJECT_ID both set)'
        : '❌ Not configured — missing BITWARDEN_ACCESS_TOKEN or BITWARDEN_PROJECT_ID';

      let bitwardenSecrets: Record<string, string> = {};
      if (userId && isBitwardenConfigured()) {
        for (const type of providers) {
          try {
            const secret = await bitwardenService.getUserSecret(userId, type as any);
            bitwardenSecrets[type] = secret ? `✅ Found (keys: ${Object.keys(secret).join(', ')})` : '❌ Not found in vault';
          } catch (e: any) {
            bitwardenSecrets[type] = `❌ Error: ${e.message}`;
          }
        }
      } else {
        bitwardenSecrets['note'] = userId
          ? 'Skipped — Bitwarden not configured'
          : 'Skipped — not authenticated';
      }

      res.json({
        timestamp: new Date().toISOString(),
        authStatus,
        bitwardenStatus,
        environmentVariables: envCheck,
        bitwardenSecretLookup: bitwardenSecrets,
        diagnosis: !userId
          ? 'You are not logged in. Include your JWT token as Authorization: Bearer <token> header, or log in first.'
          : !isBitwardenConfigured()
          ? 'Bitwarden is not configured. Add BITWARDEN_ACCESS_TOKEN and BITWARDEN_PROJECT_ID to your Azure Container App environment variables.'
          : Object.values(bitwardenSecrets).some(v => v.startsWith('❌ Not found'))
          ? 'Credentials are not found in Bitwarden. This can happen when your user account was re-created (fresh database). Go to Settings and re-save your credentials.'
          : '✅ Everything looks good — credentials are accessible.',
      });
    } catch (error: any) {
      res.status(500).json({ error: 'Diagnostic failed', details: error.message });
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
}

