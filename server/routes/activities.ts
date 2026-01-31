/**
 * Shared activities API routes
 * Handles scanning, fixing, cost analysis, and diagram generation across modules
 * These endpoints are shared by Terraform, Kubernetes, and ArchMe modules
 */

import type { Express } from "express";
import { storage } from "../storage";
import { mcpClient, type MCPProvider } from "../mcp-client";

/**
 * Register shared activities routes
 * 
 * NOTE: The following large endpoints are still in routes-legacy.ts and will be migrated separately:
 * - /api/sessions/:id/scan (~3,700 lines) - Terraform/Kubernetes security scanning
 * - /api/sessions/:id/fix-issues (~1,000 lines) - Auto-fix security issues
 * - /api/sessions/:id/analyze-cost (~1,500 lines) - Cost analysis
 */
export function registerActivityRoutes(app: Express) {
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

  // NOTE: The following endpoints are very large and still in routes-legacy.ts
  // They will be migrated in a future step:
  //
  // POST /api/sessions/:id/scan - Terraform/Kubernetes security scanning (~3,700 lines)
  // POST /api/sessions/:id/fix-issues - Auto-fix security issues (~1,000 lines)
  // POST /api/sessions/:id/analyze-cost - Cost analysis (~1,500 lines)
  //
  // These endpoints are complex and handle multiple frameworks (Terraform, Kubernetes)
  // They will be extracted carefully to maintain functionality
}

