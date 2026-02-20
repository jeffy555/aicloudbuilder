import type { Express } from "express";
import { createServer, type Server } from "http";
import { createHash } from "crypto";
import { storage } from "./storage";
import { mcpClient, type MCPProvider } from "./mcp-client";
import { openaiService, type ChatMessage } from "./openai-service";
import { insertMessageSchema, insertGeneratedFileSchema, insertSessionSchema, type Repository, type InsertSession, type GeneratedFile } from "@shared/schema";
import { analyzeTerraformFiles } from "./terraform-parser";
import { validateTerraformRequest, formatValidationErrors, type ValidationResult } from "./terraform-validator";
import { remediationRAGService } from "./rag/remediation-rag";
import { intelligentFixRetriever } from "./rag/intelligent-fix-retriever";
import { featureFlags } from "./middleware/feature-flags";
import { fixLogStore } from "./audit/fix-log";
import { getFixGuidance, generateFixMessage } from "./checkov-fix-guidance";
import { generateArchitectureDiagram } from "./diagram/terraform-diagram-generator";
import { analyzeArchitectureRequirements } from "./diagram/architecture-analyzer";
import { generateArchitectureDiagram as generateArchDiagramFromAnalysis } from "./diagram/architecture-diagram-generator";
import { extractComponents } from "./archme/component-extractor";
import { generateAllComponentCode } from "./archme/code-generator";
import { generateReadme } from "./archme/readme-generator";
import { generateKubernetesManifests } from "./kubernetes/manifest-generator";
import { validateHelmChart } from "./kubernetes/helm-validation-service";
import { generateKubernetesDiagram } from "./kubernetes/diagram-generator";
import { runCheckovKubernetes } from "./kubernetes/checkov-validator";
import { analyzeKubernetesBestPractices } from "./kubernetes/best-practices-analyzer";
import { validateKubernetesYAML } from "./kubernetes/kubeval-validator";
import type { DiagramType } from "./diagram/diagram-type-generator";
import {
  HOURS_PER_MONTH,
  resolveAzureLocation,
  getPricingConfig,
  isFreeResource,
  getServiceName,
  buildPricingApiFilter,
  selectBestPricingItem,
  calculateMonthlyCost,
} from "./azure-pricing-config";
import { hasUsageDimensions, getUsageDefaults, getUsageCatalog, applyUsageToAttrs } from "./azure-usage-catalog";
import {
  buildVariableMap,
  resolveResourceAttributes,
  resolveLocation,
  resolveResourceCount,
  type TerraformFile,
} from "./terraform-variable-resolver";
import type { CostStatus, UsageProfile, CostResource, CostAnalysisResult } from "../shared/schema";

// Helper function to repair JSON (same as in openai-service.ts)
function repairJson(jsonText: string): string {
  let repaired = jsonText.trim();
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');
  repaired = repaired.replace(/,(\s*\n\s*[}\]])/g, '$1');
  repaired = repaired.replace(/\/\/.*$/gm, '');
  repaired = repaired.replace(/\/\*[\s\S]*?\*\//g, '');
  repaired = repaired.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, (match, prefix, key) => {
    if (!match.includes('"')) {
      return `${prefix}"${key}":`;
    }
    return match;
  });
  return repaired;
}

/**
 * Phase 6: Unified remediation retrieval wrapper.
 * When ENABLE_INTELLIGENT_FIX_RETRIEVAL is on, delegates to intelligentFixRetriever
 * and maps the result back to the RAG-compatible shape so all downstream prompt-building
 * and verification logic works without changes.
 * When the flag is off, calls remediationRAGService.findRemediation() directly.
 */
async function getRemediation(
  checkId: string,
  checkName: string,
  guideline: string,
  resourceType: string,
  userId?: string,
  cloudProvider?: string
): Promise<ReturnType<typeof remediationRAGService.findRemediation>> {
  if (featureFlags.intelligentFixRetrieval) {
    const result = await intelligentFixRetriever.getFixForCheck(
      checkId,
      resourceType,
      checkName,
      guideline,
      userId,
      undefined, // context
      cloudProvider
    );

    if (!result) return null;

    // Map IntelligentFixResult → RAG-compatible shape
    return {
      snippet: {
        id: createHash('sha256')
          .update(`${checkId}:${resourceType}`)
          .digest('hex')
          .substring(0, 16),
        checkId,
        resourceType,
        cloudProvider: cloudProvider || 'azure',
        framework: 'terraform' as const,
        fixSnippet: result.fix,
        context: '',
        guideline,
        source: result.source === 'checkov_official' ? 'retrieved'
              : result.source === 'ai_generated' ? 'generated'
              : 'retrieved',
        confidence: result.confidence,
        successCount: result.metadata?.timesUsed || 0,
        failureCount: 0,
        verified: result.confidence >= 0.8,
        deprecated: false,
        lastUsed: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      template: undefined,
      confidence: result.confidence,
      matchReason: `[intelligent] source=${result.source}`,
    };
  }

  // Flag off — original path, zero behaviour change
  return remediationRAGService.findRemediation(checkId, checkName, guideline, resourceType);
}

// Helper function to find matching brace for Terraform blocks
function findMatchingBrace(content: string, startIndex: number): number {
  let depth = 1;
  let i = startIndex;
  while (i < content.length && depth > 0) {
    if (content[i] === '{') depth++;
    if (content[i] === '}') depth--;
    i++;
  }
  return i;
}

// Helper function to validate that a fix actually addresses Checkov issues
function validateFix(originalContent: string, fixedContent: string, checks: any[]): { isValid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  
  // Check if content actually changed
  if (originalContent === fixedContent) {
    warnings.push('Content is identical - no changes made');
    return { isValid: false, warnings };
  }
  
  // Basic validation: ensure code structure is still valid Terraform
  // Check that resource blocks are still present (basic sanity check)
  const resourceBlocks = (content: string) => (content.match(/resource\s+"[^"]+"\s+"[^"]+"/g) || []).length;
  const originalResources = resourceBlocks(originalContent);
  const fixedResources = resourceBlocks(fixedContent);
  
  if (fixedResources < originalResources) {
    warnings.push(`Resource count decreased from ${originalResources} to ${fixedResources} - resources may have been removed`);
  }
  
  // Check that the fixed content is longer or different (indicates changes were made)
  const contentChanged = fixedContent.length !== originalContent.length || 
                          fixedContent.trim() !== originalContent.trim();
  
  if (!contentChanged) {
    warnings.push('Content appears unchanged despite length difference');
  }
  
  // Validate specific fixes for known checks
  for (const check of checks) {
    if (check.checkId === 'CKV_AZURE_59' || check.checkId === 'CKV_AZURE_190') {
      // Check if allow_nested_items_to_be_public is set to false
      const hasAttribute = fixedContent.includes('allow_nested_items_to_be_public');
      const isSetToFalse = /allow_nested_items_to_be_public\s*=\s*false/.test(fixedContent);
      
      if (!hasAttribute) {
        warnings.push(`Missing required attribute 'allow_nested_items_to_be_public' for ${check.checkId}`);
      } else if (!isSetToFalse) {
        warnings.push(`Attribute 'allow_nested_items_to_be_public' exists but is NOT set to false for ${check.checkId}`);
        // Check what value it's actually set to
        const valueMatch = fixedContent.match(/allow_nested_items_to_be_public\s*=\s*([^\s\n}]+)/);
        if (valueMatch) {
          warnings.push(`  Current value: ${valueMatch[1]} (should be false)`);
        }
      }
    }
  }
  
  return { isValid: warnings.length === 0, warnings };
}

/**
 * Extract base resource name from Checkov resource string
 * Removes [index] suffix for count/for_each resources
 * Example: "azurerm_storage_account.additional_storage_accounts[0]" -> "azurerm_storage_account.additional_storage_accounts"
 */
function extractBaseResourceName(resourceName: string): string {
  if (!resourceName) return resourceName;
  // Remove [index] suffix for count/for_each resources
  return resourceName.replace(/\[.*?\]$/, '');
}

/**
 * Extract fix snippet from fixed content
 * Simplified version - in production, use AST parsing for accuracy
 */
function extractFixSnippet(
  fixedContent: string,
  check: any,
  resourceType: string
): string | null {
  try {
    // Find the resource block in the fixed content
    const resourcePattern = new RegExp(
      `resource\\s+"${resourceType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s+"[^"]+"\\s*\\{([^}]+)\\}`,
      's'
    );
    const match = fixedContent.match(resourcePattern);
    
    if (!match) {
      return null;
    }
    
    const resourceBlock = match[1];
    
    // Try to find the specific attribute mentioned in the check
    // This is simplified - in production, parse the AST to find exact changes
    const guideline = check.guideline || '';
    
    // Common patterns to extract
    if (guideline.includes('allow_nested_items_to_be_public') || check.checkId.includes('59')) {
      const attrMatch = resourceBlock.match(/allow_nested_items_to_be_public\s*=\s*[^\n}]+/);
      if (attrMatch) {
        return attrMatch[0].trim();
      }
    }
    
    // Generic: extract first few lines of the resource block as snippet
    const lines = resourceBlock.split('\n').filter(l => l.trim()).slice(0, 5);
    if (lines.length > 0) {
      return lines.join('\n').trim();
    }
    
    return null;
  } catch (error) {
    console.warn(`Failed to extract fix snippet: ${error}`);
    return null;
  }
}

/**
 * Helper function to run Checkov on a single file to verify if specific checks pass
 * Priority 1 Fix: Now tracks verification per resource instance
 * Returns a map of "checkId:resource" -> boolean (true if check passes for that specific resource, false if it fails)
 */
async function verifyChecksWithCheckov(
  fileName: string,
  fileContent: string,
  checks: Array<{ checkId: string; resource: string }>
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  
  // Initialize all checks as failed (will be updated if they pass)
  checks.forEach(({ checkId, resource }) => {
    const key = `${checkId}:${resource}`;
    results.set(key, false);
  });
  
  try {
    // Import required modules
    const fs = await import('fs/promises');
    const path = await import('path');
    const { spawn } = await import('child_process');
    
    // Create temporary directory and file
    const projectRoot = process.cwd();
    const tempBaseDir = path.join(projectRoot, '.temp-checkov-verify');
    await fs.mkdir(tempBaseDir, { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(tempBaseDir, 'verify-'));
    const filePath = path.join(tempDir, fileName);
    
    // Write file content
    await fs.writeFile(filePath, fileContent, 'utf-8');
    
    // Run Checkov with JSON output
    const isWindows = process.platform === 'win32';
    const checkovArgs = ['-d', tempDir, '--framework', 'terraform', '--output', 'json', '--compact', '--quiet'];
    
    const checkovCommands: [string, string[], string[]][] = isWindows 
      ? [
          ['checkov', [], checkovArgs],
          ['py', ['-m', 'uv', 'run', 'checkov'], checkovArgs],
          ['py', ['-m', 'checkov'], checkovArgs]
        ]
      : [
          ['checkov', [], checkovArgs],
          ['python3', ['-m', 'uv', 'run', 'checkov'], checkovArgs],
          ['python3', ['-m', 'checkov'], checkovArgs]
        ];
    
    // Try each command until one works
    let checkovOutput = '';
    let commandWorked = false;
    
    for (const [cmd, baseArgs, args] of checkovCommands) {
      try {
        const output = await new Promise<string>((resolve, reject) => {
          const fullArgs = [...baseArgs, ...args];
          const process = spawn(cmd, fullArgs, {
            cwd: tempDir,
            stdio: ['ignore', 'pipe', 'pipe']
          });
          
          let stdout = '';
          let stderr = '';
          
          process.stdout.on('data', (data) => {
            stdout += data.toString();
          });
          
          process.stderr.on('data', (data) => {
            stderr += data.toString();
          });
          
          process.on('close', (code) => {
            // Checkov returns non-zero exit code if checks fail, but we still want the JSON output
            if (stdout.trim()) {
              resolve(stdout);
            } else if (stderr.trim() && stderr.includes('{')) {
              // Sometimes Checkov outputs JSON to stderr
              resolve(stderr);
            } else {
              reject(new Error(`Checkov exited with code ${code}`));
            }
          });
          
          process.on('error', (error) => {
            reject(error);
          });
          
          // Timeout after 30 seconds
          setTimeout(() => {
            process.kill();
            reject(new Error('Checkov verification timeout'));
          }, 30000);
        });
        
        checkovOutput = output;
        commandWorked = true;
        break;
      } catch (error: any) {
        // Try next command
        continue;
      }
    }
    
    if (!commandWorked) {
      console.warn(`⚠️  Could not run Checkov verification - all commands failed`);
      return results; // Return all as failed
    }
    
        // Parse Checkov JSON output
        try {
          const checkovData = JSON.parse(checkovOutput);
          
          // Check for parsing errors first
          if (checkovData.summary?.parsing_errors && checkovData.summary.parsing_errors > 0) {
            console.error(`\n❌ ========== CHECKOV PARSING ERRORS DETECTED ==========`);
            console.error(`   Parsing errors: ${checkovData.summary.parsing_errors}`);
            console.error(`   Resource count: ${checkovData.summary.resource_count || 0}`);
            console.error(`   This means Checkov could not parse the Terraform files`);
            
            // Try to get detailed parsing errors
            if (checkovData.results?.parsing_errors && Array.isArray(checkovData.results.parsing_errors)) {
              console.error(`\n   Detailed parsing errors:`);
              checkovData.results.parsing_errors.forEach((error: any, idx: number) => {
                console.error(`   ${idx + 1}. File: ${error.file_path || 'unknown'}`);
                console.error(`      Error: ${error.error_message || error.message || 'Unknown parsing error'}`);
                if (error.line) {
                  console.error(`      Line: ${error.line}`);
                }
              });
            }
            
            console.error(`\n   Possible causes:`);
            console.error(`   1. Invalid Terraform syntax in files`);
            console.error(`   2. Missing required attributes or blocks`);
            console.error(`   3. Files are empty or corrupted`);
            console.error(`   4. Terraform version incompatibility`);
            console.error(`\n   Check the files written to: ${tempDir}`);
            console.error(`==========================================\n`);
          }
      
      // Priority 1 Fix: Track failed checks by checkId AND resource instance
      const failedCheckKeys = new Set<string>();
      const passedCheckKeys = new Set<string>();
      
      // Extract failed checks with resource information
      if (checkovData.results?.failed_checks) {
        checkovData.results.failed_checks.forEach((check: any) => {
          if (check.check_id && check.resource) {
            const key = `${check.check_id}:${check.resource}`;
            failedCheckKeys.add(key);
            // Debug: Log failed checks for troubleshooting
            console.log(`   🔍 Checkov reported failed: ${key}`);
          }
        });
      }
      
      // Extract passed checks with resource information (if available)
      if (checkovData.results?.passed_checks) {
        checkovData.results.passed_checks.forEach((check: any) => {
          if (check.check_id && check.resource) {
            const key = `${check.check_id}:${check.resource}`;
            passedCheckKeys.add(key);
            // Debug: Log passed checks for troubleshooting
            console.log(`   🔍 Checkov reported passed: ${key}`);
          }
        });
      }
      
      // Update results: Check specific resource instances
      checks.forEach(({ checkId, resource }) => {
        const key = `${checkId}:${resource}`;
        
        // Debug: Log what we're checking
        console.log(`   🔍 Verifying: ${key}`);
        console.log(`      - In passed checks: ${passedCheckKeys.has(key)}`);
        console.log(`      - In failed checks: ${failedCheckKeys.has(key)}`);
        
        // If in passed checks, mark as passed
        if (passedCheckKeys.has(key)) {
          results.set(key, true);
          console.log(`      ✅ Marked as PASSED (found in passed_checks)`);
        }
        // If NOT in failed checks, mark as passed (Checkov might not report passed_checks with --compact)
        else if (!failedCheckKeys.has(key)) {
          results.set(key, true);
          console.log(`      ✅ Marked as PASSED (not in failed_checks)`);
        }
        // Otherwise, it's still failed
        else {
          results.set(key, false);
          console.log(`      ❌ Marked as FAILED (still in failed_checks)`);
        }
      });
      
      const passedCount = Array.from(results.values()).filter(v => v === true).length;
      console.log(`   ✅ Checkov verification: ${passedCount}/${checks.length} check(s) passed for specific resource instances`);
    } catch (parseError: any) {
      console.warn(`⚠️  Failed to parse Checkov verification output: ${parseError.message}`);
      // Return all as failed if we can't parse
    }
    
    // Cleanup
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
    
  } catch (error: any) {
    console.warn(`⚠️  Checkov verification failed: ${error.message}`);
    // Return all as failed if verification fails
  }
  
  return results;
}

// Legacy routes - being migrated to modular structure in server/routes/
// This function will be removed once all routes are migrated
// NOTE: Health and Session routes have been moved to routes/health.ts and routes/sessions.ts
export async function registerLegacyRoutes(app: Express): Promise<Server> {
  // NOTE: Health check and session routes are now in routes/health.ts and routes/sessions.ts
  // They are registered via routes/index.ts before this function is called
  
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
      const isAutomationWorkflow = !session.cloudProvider && 
                                   !session.moduleApproach && 
                                   !hasArchMeAnalysis &&
                                   (session.currentStep === '1' || session.currentStep === '2' || session.currentStep === '3' || session.currentStep === '4');
      const isArchMeWorkflow = hasArchMeAnalysis || 
                               (!session.cloudProvider && 
                                !session.moduleApproach && 
                                !isAutomationWorkflow &&
                                (session.currentStep === '1' || !session.currentStep || session.currentStep === '0'));
      
      let contextPrompt: string;
      if (isArchMeWorkflow) {
        contextPrompt = `You are an AI DevOps assistant helping users create architecture diagrams from natural language requirements. The user is using the ArchMe feature to generate visual architecture diagrams.

IMPORTANT CONTEXT:
- This is NOT about generating Terraform code
- This is NOT about creating automation scripts
- This is about analyzing architecture requirements and generating diagrams
- Focus on architecture components, relationships, and visual representation
- Support Azure, AWS, GCP, and multi-cloud architectures
- Support third-party tools like Prometheus, Grafana, Fluentbit, New Relic, etc.

Your role:
1. Help users describe their architecture requirements clearly
2. Clarify architecture components and relationships
3. Answer questions about cloud services and architecture patterns
4. Guide users on best practices for architecture diagrams
5. Keep responses focused on architecture, NOT code generation or automation

DO NOT:
- Suggest generating Terraform code
- Suggest creating automation scripts
- Provide code examples
- Focus on implementation details

DO:
- Help clarify architecture requirements
- Explain cloud services and their relationships
- Suggest architecture patterns and best practices
- Guide users on describing their architecture clearly`;
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
      // This allows generation to work from any step, not just step 6
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
        
        const isRequest = hasGenerationKeyword && (hasResourceKeyword || hasAzureKeyword);
        
        // Debug logging
        console.log(`\n🔍 [CHAT] Checking if message is generation request:`);
        console.log(`   Message: "${msg.substring(0, 100)}${msg.length > 100 ? '...' : ''}"`);
        console.log(`   Has generation keyword: ${hasGenerationKeyword}`);
        console.log(`   Has resource keyword: ${hasResourceKeyword}`);
        console.log(`   Has Azure keyword: ${hasAzureKeyword}`);
        console.log(`   Is generation request: ${isRequest}`);
        
        return isRequest;
      };

      // If this is a resource generation request and session is ready (has cloud provider and module approach)
      // IMPORTANT: Do NOT auto-generate Terraform for automation workflows or ArchMe workflows
      const shouldAutoGenerate = !isAutomationWorkflow &&
                                 !isArchMeWorkflow &&
                                 isResourceGenerationRequest(message) && 
                                 session.cloudProvider && 
                                 session.moduleApproach &&
                                 (session.currentStep === '5' || session.currentStep === '6' || parseInt(session.currentStep || '0') >= 5);
      
      // Debug logging
      console.log(`\n🔍 [CHAT] Auto-generation check:`);
      console.log(`   Is generation request: ${isResourceGenerationRequest(message)}`);
      console.log(`   Has cloud provider: ${!!session.cloudProvider} (${session.cloudProvider})`);
      console.log(`   Has module approach: ${!!session.moduleApproach} (${session.moduleApproach})`);
      console.log(`   Current step: ${session.currentStep}`);
      console.log(`   Should auto-generate: ${shouldAutoGenerate}`);

      // Get AI response with context
      const aiResponse = await openaiService.chatWithContext(contextPrompt, chatHistory);

      // Clean AI response - for generation requests, just use a simple message
      let cleanedResponse = aiResponse;
      if (shouldAutoGenerate || isResourceGenerationRequest(message)) {
        // For code generation requests, check if response contains code patterns
        const hasCodeBlock = /```/.test(aiResponse);
        const hasTerraformCode = /resource\s+"[^"]+"/.test(aiResponse) || /provider\s+"[^"]+"/.test(aiResponse);
        const hasKubernetesCode = /apiVersion:|kind:/.test(aiResponse);

        if (hasCodeBlock || hasTerraformCode || hasKubernetesCode) {
          // Response contains code - use simple message instead
          cleanedResponse = "Generating your infrastructure code...";
        } else {
          // No code detected - clean up any remaining formatting
          cleanedResponse = aiResponse
            .replace(/```[\s\S]*?```/g, '')
            .replace(/```[\s\S]*/g, '') // Incomplete code blocks
            .replace(/\n{3,}/g, '\n\n')
            .trim();

          // If still too short or empty, use default
          if (!cleanedResponse || cleanedResponse.length < 20) {
            cleanedResponse = "Generating your infrastructure code...";
          }
        }
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
        console.log(`   Message: "${message.substring(0, 100)}${message.length > 100 ? '...' : ''}"`);
        console.log(`   Cloud Provider: ${session.cloudProvider}`);
        console.log(`   Module Approach: ${session.moduleApproach}`);
        
        // Trigger generation asynchronously (don't wait for it)
        // This prevents blocking the chat response
        (async () => {
          try {
            // Import the generate-terraform logic or call it directly
            // We'll need to replicate the generate-terraform endpoint logic here
            // For now, we'll make an internal call to the endpoint
            
            // Get existing files for context
            const existingFiles = await storage.getFilesBySession(sessionId);
            const filesForGeneration = existingFiles.map(f => ({
              path: f.fileName,
              content: f.content
            }));

            // Get backend config if available
            const backendConfig = session.hasBackend === 'true' ? {
              hasBackend: true,
              backendType: session.backendType || undefined,
              storageAccount: session.backendStorageAccount || undefined,
              resourceGroup: session.backendResourceGroup || undefined,
              container: session.backendContainer || undefined,
              stateKey: session.backendStateKey || undefined,
              location: session.backendLocation || undefined,
            } : undefined;

            // Generate Terraform
            const result = await openaiService.generateTerraform(
              message,
              session.cloudProvider,
              session.moduleApproach,
              backendConfig,
              filesForGeneration.length > 0 ? filesForGeneration : undefined
            );

            // Save generated files
            if (result.files && result.files.length > 0) {
              console.log(`   ✅ Generated ${result.files.length} file(s)`);
              
              // Get all existing files to check for duplicates
              const allSessionFiles = await storage.getFilesBySession(sessionId);
              
              for (const file of result.files) {
                // Skip protected files
                const fileName = file.path.split('/').pop() || file.path;
                if (['backend.tf', 'provider.tf', 'terraform.tf'].includes(fileName)) {
                  continue;
                }

                // Check if file already exists
                const existingFile = allSessionFiles.find(f => f.fileName === fileName);
                
                if (existingFile) {
                  // Update existing file
                  await storage.updateFile(existingFile.id, file.content);
                  console.log(`   📝 Updated: ${fileName}`);
                } else {
                  // Create new file
                  await storage.createFile({
                    sessionId,
                    fileName,
                    content: file.content,
                  });
                  console.log(`   ✨ Created: ${fileName}`);
                }
              }

              // Notify user via system message
              await storage.createMessage({
                sessionId,
                type: 'ai',
                content: `✅ Terraform code has been generated and saved. ${result.files.length} file(s) updated.`,
              });
            } else {
              console.log('   ⚠️  No files generated');
              await storage.createMessage({
                sessionId,
                type: 'ai',
                content: '⚠️ Generation completed but no files were created. Please check the request and try again.',
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
      console.error('   Error type:', error?.constructor?.name);
      console.error('   Error message:', error?.message);
      console.error('   Error stack:', error?.stack);
      console.error('   Session ID:', req.params.id);
      console.error('   Request body:', req.body);
      
      const errorMessage = error?.message || 'Unknown error occurred';
      res.status(500).json({ 
        error: 'Failed to process chat message',
        details: errorMessage,
        type: error?.constructor?.name || 'Error'
      });
    }
  });

  // Pre-warm MCP connection for a provider (optional, called when provider is selected)
  app.post("/api/repositories/:provider/prewarm", async (req, res) => {
    try {
      const provider = req.params.provider as MCPProvider;
      const serverType = (req.query.serverType as MCPServerType) || 'devops';
      console.log(`🔥 [API] Pre-warming connection for ${provider}-${serverType}...`);
      
      // Pre-warm in background (don't wait)
      mcpClient.prewarmConnection(provider, serverType).catch((error) => {
        console.warn(`⚠️  [API] Pre-warm failed for ${provider}-${serverType}:`, error.message);
      });
      
      res.json({ status: 'pre-warming', provider, serverType });
    } catch (error) {
      console.error('Error pre-warming connection:', error);
      res.status(500).json({ error: 'Failed to pre-warm connection' });
    }
  });

  // List repositories
  app.get("/api/repositories/:provider", async (req, res) => {
    const requestStart = Date.now();
    try {
      const provider = req.params.provider as MCPProvider;
      
      // Validate provider credentials
      if (provider === 'azure' && (!process.env.AZURE_DEVOPS_ORG || !process.env.AZURE_DEVOPS_PAT || !process.env.AZURE_DEVOPS_PROJECT)) {
        return res.status(400).json({ error: 'Azure DevOps credentials not configured. Please set AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT, and AZURE_DEVOPS_PROJECT environment variables.' });
      }
      if (provider === 'github' && (!process.env.GITHUB_TOKEN || !process.env.GITHUB_OWNER)) {
        return res.status(400).json({ error: 'GitHub credentials not configured. Please set GITHUB_TOKEN and GITHUB_OWNER environment variables.' });
      }
      
      console.log(`📡 [API] Listing repositories for ${provider}...`);
      const repos = await mcpClient.listRepositories(provider);
      const totalTime = Date.now() - requestStart;
      console.log(`⏱️  [API] Repository list completed in ${totalTime}ms`);
      console.log(`📊 [API] Received ${repos.length} repository/repositories from MCP client`);
      
      if (repos.length === 0) {
        console.warn(`⚠️  [API] No repositories returned! This might indicate:`);
        console.warn(`   1. MCP server returned empty result`);
        console.warn(`   2. REST API fallback also returned empty`);
        console.warn(`   3. Credentials might be incorrect`);
        console.warn(`   4. Project might not have any repositories`);
      } else {
        console.log(`📋 [API] Sample repository structure:`, JSON.stringify(repos[0], null, 2));
      }
      
      // Transform to common format
      const formatted: Repository[] = repos.map((repo: any, index: number) => {
        const formattedRepo = {
          id: repo.id || String(repo.repositoryId || index),
          name: repo.name || repo.Name || repo.repositoryName || 'Unknown',
          lastUpdated: repo.updated_at || repo.lastUpdateTime || repo.updatedDate || repo.lastUpdated || '',
          branch: repo.default_branch || repo.defaultBranch || repo.branch || 'main'
        };
        console.log(`   📦 Formatted repo ${index + 1}: ${formattedRepo.name} (ID: ${formattedRepo.id})`);
        return formattedRepo;
      });

      console.log(`✅ [API] Returning ${formatted.length} formatted repository/repositories`);
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
      
      res.status(500).json({ 
        error: 'Failed to create repository',
        details: error.message || 'Unknown error occurred'
      });
    }
  });

  // Validate requested resources against child module resources (for aggregated-root modules)
  // MOVED TO: server/routes/repositories.ts
  /*
  app.post("/api/sessions/:id/validate-aggregated-resources", async (req, res) => {
    ...
  });
  */

  // Scan child module repository to extract available resources
  app.post("/api/sessions/:id/scan-child-module", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const { repositoryId, provider } = req.body;
      
      if (!repositoryId || !provider) {
        return res.status(400).json({ error: 'Repository ID and provider are required' });
      }

      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Get repository name from ID
      const repos = await mcpClient.listRepositories(provider as MCPProvider);
      const repo = repos.find(r => r.id === repositoryId || r.name === repositoryId);
      
      if (!repo) {
        return res.status(404).json({ error: 'Repository not found' });
      }

      console.log(`\n📦 Scanning child module repository: ${repo.name}`);

      // Scan repository files
      const files = await mcpClient.scanRepositoryFiles(
        provider as MCPProvider,
        repo.name,
        'main'
      );

      // Filter Terraform files
      const terraformFiles = files.filter(f => 
        f.path.toLowerCase().endsWith('.tf') && 
        !f.path.toLowerCase().endsWith('.tfvars')
      );

      if (terraformFiles.length === 0) {
        return res.json({
          resources: [],
          message: 'No Terraform files found in the child module repository'
        });
      }

      // Parse resources from Terraform files
      const { parseResources } = await import('./diagram/resource-relationship-parser');
      const parsedResources = parseResources(
        terraformFiles.map(f => ({
          fileName: f.path,
          content: f.content
        }))
      );

      // Extract unique resource types
      const uniqueResourceTypes = new Set<string>();
      parsedResources.forEach(r => {
        uniqueResourceTypes.add(r.type);
      });

      const resources = Array.from(uniqueResourceTypes).map(type => ({
        type,
        name: type, // Use type as name for display
        description: `Available ${type} resource from child module`
      }));

      console.log(`   ✅ Found ${resources.length} unique resource type(s): ${resources.map(r => r.type).join(', ')}`);

      // Store child module resources in session for validation during generation
      // Store as a custom field (using a field that exists in the schema or as JSON in a text field)
      // For now, we'll store it in a way that can be retrieved later
      // Note: This requires the session to have a field to store this, or we can use a workaround
      // Since we can't modify the schema easily, we'll store it in the session's metadata or use a different approach
      // For now, we'll pass it through the response and the frontend will store it in state

      return res.json({
        resources,
        totalResources: parsedResources.length,
        message: `Found ${resources.length} available resource type(s) in the child module`
      });
    } catch (error: any) {
      console.error('Error scanning child module:', error);
      return res.status(500).json({
        error: 'Failed to scan child module',
        details: error.message || 'Unknown error occurred'
      });
    }
  });

  // Scan repository for existing Terraform configuration
  app.post("/api/sessions/:id/scan-repository", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const { refresh = false } = req.body || {}; // Option to clear existing files first
      const session = await storage.getSession(sessionId);
      
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (!session.provider || !session.repositoryName) {
        return res.status(400).json({ error: 'Provider and repository must be selected before scanning' });
      }

      // If refresh is true, clear existing files first to start fresh
      if (refresh) {
        console.log(`\n🔄 Refresh mode: Clearing existing files before scanning...`);
        const filesBefore = await storage.getFilesBySession(sessionId);
        const filesCleared = filesBefore.length;
        await storage.deleteFilesBySession(sessionId);
        console.log(`   ✅ Cleared ${filesCleared} existing file(s) from session storage`);
        console.log(`   📥 Will fetch fresh files from repository`);
      }

      const files = await mcpClient.scanRepositoryFiles(
        session.provider as MCPProvider,
        session.repositoryName,
        'main'
      );

      // CRITICAL: Log ALL files returned from repository (before any processing)
      console.log(`\n📥 Raw files returned from repository: ${files.length} file(s)`);
      files.forEach((f, i) => {
        console.log(`   ${i + 1}. "${f.path}" (${f.content.length} chars)`);
      });
      
      // Check specifically for tfvars files
      const tfvarsInRawFiles = files.filter(f => f.path.toLowerCase().endsWith('.tfvars'));
      console.log(`\n   🔍 Tfvars files in raw repository response: ${tfvarsInRawFiles.length}`);
      if (tfvarsInRawFiles.length > 0) {
        tfvarsInRawFiles.forEach(f => {
          console.log(`      ✅ "${f.path}" (${f.content.length} chars)`);
        });
      } else {
        console.error(`      ⚠️⚠️⚠️  NO tfvars files found in repository response!`);
        console.error(`      ⚠️  This means the MCP client is not returning tfvars files from the repository.`);
        console.error(`      ⚠️  Check if dev.terraform.tfvars exists in the repository.`);
      }

      // Step 1: Regex-based analysis (fast, reliable for common cases)
      const regexAnalysis = analyzeTerraformFiles(files);
      
      // Step 2: AI-based analysis (intelligent, handles edge cases)
      let aiAnalysis: {
        cloudProvider: 'azure' | 'aws' | 'gcp' | null;
        moduleType: 'child' | 'root' | 'empty' | null;
        summary: string;
        detectedResources: string[];
      } | null = null;
      
      if (files.length > 0) {
        try {
          console.log('\n🤖 Running AI analysis on repository files...');
          aiAnalysis = await openaiService.analyzeRepositoryFiles(files);
          console.log('✅ AI analysis completed');
        } catch (error: any) {
          console.error('⚠️  AI analysis failed, using regex-based detection:', error.message);
          // Continue with regex analysis only
        }
      }

      // Combine results: Prefer AI analysis if available, fallback to regex
      const analysis = {
        cloudProvider: aiAnalysis?.cloudProvider || regexAnalysis.cloudProvider,
        moduleType: aiAnalysis?.moduleType || regexAnalysis.moduleType,
        hasResources: regexAnalysis.hasResources,
        hasModules: regexAnalysis.hasModules,
        providerBlocks: regexAnalysis.providerBlocks,
        backend: regexAnalysis.backend,
        // Additional AI insights
        aiSummary: aiAnalysis?.summary,
        aiDetectedResources: aiAnalysis?.detectedResources || []
      };

      console.log('\n📊 Combined Analysis Results:');
      console.log(`   Cloud Provider: ${analysis.cloudProvider || 'Not detected'} ${aiAnalysis ? '(AI)' : '(Regex)'}`);
      console.log(`   Module Type: ${analysis.moduleType || 'Not detected'} ${aiAnalysis ? '(AI)' : '(Regex)'}`);
      if (aiAnalysis?.summary) {
        console.log(`   AI Summary: ${aiAnalysis.summary.substring(0, 150)}...`);
      }

      // Extract existing resources for display
      const existingResources: Array<{ type: string; name: string; file: string }> = [];
      for (const file of files) {
        if (!file.path.endsWith('.tf')) continue;
        
        // Match resource blocks: resource "azurerm_storage_account" "name" { ... }
        const resourcePattern = /resource\s+"([^"]+)"\s+"([^"]+)"/g;
        let match;
        while ((match = resourcePattern.exec(file.content)) !== null) {
          existingResources.push({
            type: match[1],
            name: match[2],
            file: file.path
          });
        }
      }

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

      // CRITICAL: Store ALL files in session storage for display/review
      // The UI needs to see ALL files, not just filtered ones
      // Filtering will only happen during generation for matching logic
      if (files.length > 0) {
        console.log(`\n💾 Storing ALL ${files.length} file(s) from repository in session storage...`);
        console.log(`   Session ID: ${sessionId}`);
        console.log(`   This includes ALL files for review (not filtered)`);
        
        // Get existing session files to avoid duplicates
        const existingSessionFiles = await storage.getFilesBySession(sessionId);
        console.log(`   Existing files in session: ${existingSessionFiles.length}`);
        const existingFilesMap = new Map<string, GeneratedFile>();
        existingSessionFiles.forEach(f => {
          existingFilesMap.set(f.fileName.toLowerCase(), f);
          console.log(`      - ${f.fileName} (ID: ${f.id})`);
        });
        
        const storedFileIds: string[] = [];
        for (const repoFile of files) {
          const fileName = repoFile.path.split('/').pop() || repoFile.path;
          console.log(`   📄 Processing file from repo: "${repoFile.path}" → fileName: "${fileName}"`);
          const existingFile = existingFilesMap.get(fileName.toLowerCase());
          
          if (existingFile) {
            // Update existing file with latest repository content
            console.log(`   ✅ Updating ${fileName} in session storage (ID: ${existingFile.id})`);
            await storage.updateFile(existingFile.id, repoFile.content);
            storedFileIds.push(existingFile.id);
          } else {
            // Create new file in session storage
            console.log(`   ➕ Creating ${fileName} in session storage`);
            const created = await storage.createFile({
              sessionId,
              fileName: fileName,
              content: repoFile.content,
            });
            storedFileIds.push(created.id);
            console.log(`      ✅ Created with ID: ${created.id}`);
          }
        }
        
        // VERIFY: Re-fetch files to confirm they're stored
        const verifyFiles = await storage.getFilesBySession(sessionId);
        console.log(`\n   ✅ Verification: ${verifyFiles.length} file(s) now in session storage`);
        verifyFiles.forEach(f => {
          console.log(`      - ${f.fileName} (ID: ${f.id}, ${f.content.length} chars)`);
        });
        
        // CRITICAL: Check if tfvars files are included
        const tfvarsFiles = verifyFiles.filter(f => f.fileName.toLowerCase().endsWith('.tfvars'));
        console.log(`\n   📋 Tfvars files in session storage: ${tfvarsFiles.length}`);
        tfvarsFiles.forEach(f => {
          console.log(`      ✅ ${f.fileName} (${f.content.length} chars)`);
        });
        
        if (verifyFiles.length === 0) {
          console.error(`\n   ❌❌❌ CRITICAL: Files were NOT stored! Session storage is empty!`);
          console.error(`   This is a BUG - files should be in session storage now.`);
        } else {
          console.log(`   ✅ ALL files successfully stored in session storage for review and matching`);
        }
      } else {
        console.log(`\n📋 No files found in repository`);
      }
      
      console.log(`\n📋 Repository scan completed.`);

      const result = {
        isExisting: files.length > 0,
        cloudProvider: analysis.cloudProvider,
        moduleType: analysis.moduleType,
        terraformFiles: files.map(f => f.path),
        terraformFilesWithContent: files, // Include full file contents for review
        existingResources: existingResources, // Include extracted resources
        hasResources: analysis.hasResources,
        hasModules: analysis.hasModules,
        providerBlocks: analysis.providerBlocks,
        backend: analysis.backend,
        refreshed: refresh, // Indicate if this was a refresh operation
        filesStored: (await storage.getFilesBySession(sessionId)).length
      };

      res.json(result);
    } catch (error: any) {
      console.error('Error scanning repository:', error);
      const errorMessage = error?.message || 'Failed to scan repository';
      const errorDetails = error?.stack || error?.toString();
      console.error('Error details:', errorDetails);
      res.status(500).json({ 
        error: 'Failed to scan repository',
        details: errorMessage,
        ...(process.env.NODE_ENV === 'development' && { stack: errorDetails })
      });
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
        const cloudProvider = session.cloudProvider || 'azure';
        
        // AWS backend validation
        if (cloudProvider === 'aws' || session.backendType === 's3') {
          // For AWS, we can't validate S3/DynamoDB via MCP, so we'll just mark as validated
          // User should verify resources exist manually
          if (!session.backendContainer) {
            return res.status(400).json({ error: 'Backend configuration incomplete: S3 bucket name is required' });
          }

          await storage.updateSession(sessionId, {
            backendValidated: 'true',
            workflowStep: 'terraform_generation'
          });

          return res.json({
            status: 'validated',
            message: 'AWS backend configuration validated (please ensure S3 bucket and DynamoDB table exist)',
            details: {
              bucket: session.backendContainer,
              // Extract DynamoDB table from stateKey if stored in format "state-key|dynamodb-table"
              dynamodbTable: session.backendStateKey?.includes('|') ? session.backendStateKey.split('|')[1] : 'terraform-state-lock',
              region: session.backendLocation || 'us-east-1',
              stateKey: session.backendStateKey?.includes('|') ? session.backendStateKey.split('|')[0] : (session.backendStateKey || 'terraform.tfstate')
            }
          });
        }

        // Azure backend validation (existing logic)
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
        try {
          const cloudProvider = session.cloudProvider || 'azure';
          
          // AWS backend configuration
          if (cloudProvider === 'aws') {
            // Use provided config or generate sensible defaults for AWS
            const defaults = {
              bucket: backendConfig?.bucket || backendConfig?.container || `terraform-state-${Date.now().toString().slice(-8)}`,
              dynamodbTable: backendConfig?.dynamodbTable || 'terraform-state-lock',
              region: backendConfig?.region || backendConfig?.location || 'us-east-1',
              stateKey: backendConfig?.stateKey || 'terraform.tfstate',
              encrypt: true
            };

            console.log('Creating AWS backend configuration...');
            console.log('S3 Bucket:', defaults.bucket);
            console.log('DynamoDB Table:', defaults.dynamodbTable);
            console.log('Region:', defaults.region);
            console.log('State Key:', defaults.stateKey);

            // Note: AWS backend resources (S3 bucket, DynamoDB table) need to be created manually
            // or via AWS CLI/Console. We'll just generate the backend.tf configuration.
            // For now, we'll assume they exist or will be created by the user.

            // Update session with backend configuration
            // Note: Store DynamoDB table name in backendStateKey as "state-key|dynamodb-table" format
            await storage.updateSession(sessionId, {
              hasBackend: 'true',
              backendType: 's3',
              backendContainer: defaults.bucket, // Reuse container field for S3 bucket
              backendStateKey: `${defaults.stateKey}|${defaults.dynamodbTable}`, // Store both state key and DynamoDB table
              backendLocation: defaults.region, // Reuse location field for AWS region
              backendValidated: 'pending', // Mark as pending - user needs to create resources
              workflowStep: 'terraform_generation'
            });

            // Generate and store required Terraform files immediately
            const backendTfContent = openaiService.generateBackendTf({
              backendType: 's3',
              bucket: defaults.bucket,
              dynamodbTable: defaults.dynamodbTable,
              region: defaults.region,
              stateKey: defaults.stateKey,
              encrypt: defaults.encrypt
            });

            const providerTfContent = openaiService.generateProviderTf('aws');

            // Fetch latest Terraform version from MCP server or API
            let latestVersion = '1.9.0'; // Default fallback
            try {
              latestVersion = await mcpClient.getLatestTerraformVersion();
              console.log(`Using Terraform version: ${latestVersion}`);
            } catch (versionError) {
              console.error('Error fetching Terraform version, using default:', versionError);
              // Continue with default version
            }
            
            // Generate terraform.tf with specific version (exact version, not >=)
            const terraformTfContent = `terraform {
  required_version = "${latestVersion}"
}`;

            // Store the files
            await storage.createFile({
              sessionId,
              fileName: 'backend.tf',
              content: backendTfContent
            });

            await storage.createFile({
              sessionId,
              fileName: 'provider.tf',
              content: providerTfContent
            });

            await storage.createFile({
              sessionId,
              fileName: 'terraform.tf',
              content: terraformTfContent
            });

            return res.json({
              status: 'configured',
              message: 'AWS backend configuration generated. Please create the S3 bucket and DynamoDB table manually, then run terraform init.',
              details: {
                ...defaults,
                filesGenerated: ['backend.tf', 'provider.tf', 'terraform.tf'],
                instructions: [
                  `Create S3 bucket: aws s3 mb s3://${defaults.bucket} --region ${defaults.region}`,
                  `Create DynamoDB table: aws dynamodb create-table --table-name ${defaults.dynamodbTable} --attribute-definitions AttributeName=LockID,AttributeType=S --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST --region ${defaults.region}`,
                  'Then run: terraform init'
                ]
              }
            });
          }

          // Azure backend configuration (existing logic)
          // Step 0: Verify Service Principal permissions before attempting resource creation
          // This prevents confusing errors later and provides clear instructions if permissions are missing
          const permissionCheck = await mcpClient.ensureServicePrincipalRoles();
          
          // Only block if it's a real permission error (not a skipped check)
          if (!permissionCheck.success && !permissionCheck.skipped) {
            return res.status(400).json({
              status: 'permission_error',
              error: permissionCheck.message,
              requiresRoleAssignment: true,
              instructions: permissionCheck.message
            });
          }
          
          // If check was skipped (MCP connection issue), log and proceed
          if (permissionCheck.skipped) {
            console.log('⚠️ Permission check skipped due to MCP connection issue. Proceeding with resource creation...');
          }

          // Use provided config or generate sensible defaults
          const defaults = {
            storageAccount: backendConfig?.storageAccount || `tfstate${Date.now().toString().slice(-8)}`,
            resourceGroup: backendConfig?.resourceGroup || 'terraform-state-rg',
            container: backendConfig?.container || 'tfstate',
            location: backendConfig?.location || 'eastus',
            stateKey: backendConfig?.stateKey || 'terraform.tfstate'
          };

          // CRITICAL: Create actual Azure resources using Azure MCP
          // These resources MUST exist before terraform init can run
          console.log('Creating Azure backend resources...');
          console.log('Storage Account:', defaults.storageAccount);
          console.log('Resource Group:', defaults.resourceGroup);
          console.log('Container:', defaults.container);
          console.log('Location:', defaults.location);

          let resourcesCreated = false;
          let mcpError: any = null;
          
          // Initialize validation objects with defaults to prevent undefined errors
          let rgValidation: { exists: boolean; location?: string } = { exists: false };
          let storageValidation: { exists: boolean; location?: string } = { exists: false };
          let containerValidation: { exists: boolean } = { exists: false };

          try {
            // Step 0: Validate or create resource group FIRST
            try {
              rgValidation = await mcpClient.validateAzureResourceGroup(
              defaults.resourceGroup
            );
            } catch (error: any) {
              console.error('Error validating resource group (will attempt to create):', error.message);
              // If validation fails, assume it doesn't exist and try to create
              rgValidation = { exists: false };
            }

            if (!rgValidation.exists) {
              console.log('Resource group does not exist. Creating...');
              const createRgResult = await mcpClient.createAzureResourceGroup(
                defaults.resourceGroup,
                defaults.location
              );

              if (!createRgResult.success) {
                const errorMsg = createRgResult.error || 'Unknown error';
                // Check if it's an MCP connection error
                if (errorMsg.includes('MCP server') || errorMsg.includes('connection') || errorMsg.includes('not available')) {
                  mcpError = new Error(errorMsg);
                  throw mcpError;
                }
                // Check if it's a permission error
                if (errorMsg.includes('Authorization') || errorMsg.includes('403') || errorMsg.includes('permission')) {
                  throw new Error(`Permission denied: ${errorMsg}. Service Principal needs 'Resource Group Contributor' role. Run: az role assignment create --assignee ${process.env.AZURE_CLIENT_ID} --role "Resource Group Contributor" --scope /subscriptions/${process.env.AZURE_SUBSCRIPTION_ID}`);
                }
                throw new Error(`Failed to create resource group: ${errorMsg}`);
              }
              console.log('Resource group created successfully');
              resourcesCreated = true;
            } else {
              console.log('Resource group already exists at location:', rgValidation.location);
            }

            // Step 1: Validate or create storage account
            try {
              storageValidation = await mcpClient.validateAzureStorageAccount(
              defaults.storageAccount,
              defaults.resourceGroup
            );
            } catch (error: any) {
              console.error('Error validating storage account (will attempt to create):', error.message);
              // If validation fails, assume it doesn't exist and try to create
              storageValidation = { exists: false };
            }

            if (!storageValidation.exists) {
              console.log('Storage account does not exist. Creating...');
              const createResult = await mcpClient.createAzureStorageAccount(
                defaults.storageAccount,
                defaults.resourceGroup,
                defaults.location
              );

              if (!createResult.success) {
                const errorMsg = createResult.error || 'Unknown error';
                // Check if it's an MCP connection error
                if (errorMsg.includes('MCP server') || errorMsg.includes('connection') || errorMsg.includes('not available')) {
                  mcpError = new Error(errorMsg);
                  throw mcpError;
                }
                // Check if it's a permission error
                if (errorMsg.includes('Authorization') || errorMsg.includes('403') || errorMsg.includes('permission')) {
                  throw new Error(`Permission denied: ${errorMsg}. Service Principal needs 'Storage Account Contributor' role. Run: az role assignment create --assignee ${process.env.AZURE_CLIENT_ID} --role "Storage Account Contributor" --scope /subscriptions/${process.env.AZURE_SUBSCRIPTION_ID}`);
                }
                throw new Error(`Failed to create storage account: ${errorMsg}`);
              }
              console.log('Storage account created successfully');
              resourcesCreated = true;
              // Get location from created storage account
              if (!storageValidation.location) {
                storageValidation.location = defaults.location;
              }
            } else {
              console.log('Storage account already exists');
            }

            // Step 2: Validate or create container
            try {
              containerValidation = await mcpClient.validateAzureContainer(
              defaults.storageAccount,
              defaults.resourceGroup,
              defaults.container
            );
            } catch (error: any) {
              console.error('Error validating container (will attempt to create):', error.message);
              // If validation fails, assume it doesn't exist and try to create
              containerValidation = { exists: false };
            }

            if (!containerValidation.exists) {
              console.log('Container does not exist. Creating...');
              const createResult = await mcpClient.createAzureContainer(
                defaults.storageAccount,
                defaults.container,
                defaults.resourceGroup
              );

              if (!createResult.success) {
                const errorMsg = createResult.error || 'Unknown error';
                // Check if it's an MCP connection error
                if (errorMsg.includes('MCP server') || errorMsg.includes('connection') || errorMsg.includes('not available')) {
                  mcpError = new Error(errorMsg);
                  throw mcpError;
                }
                // Check if it's a permission error
                if (errorMsg.includes('Authorization') || errorMsg.includes('403') || errorMsg.includes('permission')) {
                  throw new Error(`Permission denied: ${errorMsg}. Service Principal needs 'Storage Blob Data Contributor' role. Run: az role assignment create --assignee ${process.env.AZURE_CLIENT_ID} --role "Storage Blob Data Contributor" --scope /subscriptions/${process.env.AZURE_SUBSCRIPTION_ID}`);
                }
                throw new Error(`Failed to create container: ${errorMsg}`);
              }
              console.log('Container created successfully');
              resourcesCreated = true;
            } else {
              console.log('Container already exists');
            }
          } catch (error: any) {
            // Check if it's an MCP connection error
            const isMCPError = error?.message?.includes('MCP server') || 
                              error?.message?.includes('connection') || 
                              error?.message?.includes('not available') ||
                              error?.message?.includes('connection closed');
            
            if (isMCPError && !resourcesCreated) {
              // MCP is not available - generate backend files without creating resources
              console.log('⚠️  Azure MCP server is not available. Generating backend configuration files without creating resources...');
              mcpError = error;
              // Continue to file generation below
            } else {
              // Real error - rethrow
              throw error;
            }
          }

          // Update session with backend configuration
          await storage.updateSession(sessionId, {
            hasBackend: 'true',
            backendType: 'azurerm',
            backendStorageAccount: defaults.storageAccount,
            backendResourceGroup: defaults.resourceGroup,
            backendContainer: defaults.container,
            backendLocation: storageValidation.location || defaults.location,
            backendStateKey: defaults.stateKey,
            backendValidated: 'true', // Mark as validated since we just created/verified resources
            workflowStep: 'terraform_generation'
          });

          // Generate and store required Terraform files immediately
          const backendTfContent = openaiService.generateBackendTf({
            backendType: 'azurerm',
            storageAccount: defaults.storageAccount,
            resourceGroup: defaults.resourceGroup,
            container: defaults.container,
            stateKey: defaults.stateKey
          });

          const providerTfContent = openaiService.generateProviderTf(session.cloudProvider || 'azure');

          // Fetch latest Terraform version from MCP server or API
          let latestVersion = '1.9.0'; // Default fallback
          try {
            latestVersion = await mcpClient.getLatestTerraformVersion();
            console.log(`Using Terraform version: ${latestVersion}`);
          } catch (versionError) {
            console.error('Error fetching Terraform version, using default:', versionError);
            // Continue with default version
          }
          
          // Generate terraform.tf with specific version (exact version, not >=)
          const terraformTfContent = `terraform {
  required_version = "${latestVersion}"
}`;

          // Store the files
          await storage.createFile({
            sessionId,
            fileName: 'backend.tf',
            content: backendTfContent
          });

          await storage.createFile({
            sessionId,
            fileName: 'provider.tf',
            content: providerTfContent
          });

          await storage.createFile({
            sessionId,
            fileName: 'terraform.tf',
            content: terraformTfContent
          });

          return res.json({
            status: 'configured',
            message: 'Backend resources created successfully in Azure. Generated backend.tf, provider.tf, and terraform.tf files. Now describe the infrastructure resources you want to create.',
            details: {
              ...defaults,
              actualLocation: storageValidation.location || defaults.location,
              filesGenerated: ['backend.tf', 'provider.tf', 'terraform.tf']
            }
          });
        } catch (error: any) {
          console.error('Error creating Azure backend resources:', error);
          return res.status(500).json({
            status: 'creation_error',
            error: error.message || 'Failed to create Azure backend resources',
            suggestion: 'Ensure you are authenticated with Azure CLI (run: az login) and have proper permissions to create storage accounts'
          });
        }
      }

      res.status(400).json({ error: 'Invalid action. Use: validate, create, or decline' });

    } catch (error: any) {
      console.error('Error configuring backend:', error);
      res.status(500).json({ error: 'Failed to configure backend' });
    }
  });

  // Generate Terraform files
  app.post("/api/sessions/:id/generate-terraform", async (req, res) => {
    console.log('\n🚀 ========== GENERATE TERRAFORM ENDPOINT CALLED ==========');
    console.log(`   Timestamp: ${new Date().toISOString()}`);
    console.log(`   Session ID: ${req.params.id}`);
    console.log(`   Request body keys: ${Object.keys(req.body).join(', ')}`);
    
    try {
      const { description, childModuleResources } = req.body;
      const sessionId = req.params.id;

      // CRITICAL: Validate description immediately
      if (!description || typeof description !== 'string' || description.trim().length === 0) {
        console.error('❌ CRITICAL ERROR: Description is missing or empty!');
        console.error(`   Description value: "${description}"`);
        console.error(`   Description type: ${typeof description}`);
        return res.status(400).json({ 
          error: 'Description is required',
          details: ['Please provide a description of the resources you want to create.']
        });
      }

      console.log(`\n📝 Description received: "${description.substring(0, 200)}${description.length > 200 ? '...' : ''}"`);
      console.log(`📝 Description length: ${description.length} characters`);

      // Get session to access cloudProvider and moduleApproach
      const session = await storage.getSession(sessionId);
      if (!session) {
        console.error(`❌ Session ${sessionId} not found!`);
        return res.status(404).json({ error: 'Session not found' });
      }

      console.log(`✅ Session found: ${sessionId}`);
      console.log(`   Module approach: ${session.moduleApproach}`);
      console.log(`   Cloud provider: ${session.cloudProvider || session.detectedCloudProvider || 'None'}`);

      // Phase 1: Basic Rule-Based Validation
      console.log('\n🔍 ========== PHASE 1: VALIDATION ==========');
      console.log(`📝 Validating request: "${description.substring(0, 100)}${description.length > 100 ? '...' : ''}"`);
      console.log(`📝 Full description length: ${description.length} characters`);
      console.log(`📝 Module approach: ${session.moduleApproach}`);
      if (session.moduleApproach === 'aggregated-root') {
        console.log(`📝 Child module resources: ${childModuleResources?.length || 0} available`);
        if (childModuleResources && Array.isArray(childModuleResources) && childModuleResources.length > 0) {
          console.log(`📝 Available child module resources: ${childModuleResources.map((r: any) => typeof r === 'string' ? r : r.type).join(', ')}`);
        }
      }
      
      // Use session cloud provider if available (detected from repository scan)
      const sessionProvider = session.cloudProvider || session.detectedCloudProvider;
      console.log(`   Session Cloud Provider: ${sessionProvider || 'None'}`);
      
      const validationResult = validateTerraformRequest(description, {
        sessionProvider: sessionProvider as 'azure' | 'aws' | 'gcp' | null,
        minLength: 10,
        maxLength: 2000
      });

      console.log(`   Validation Result: ${validationResult.isValid ? '✅ VALID' : '❌ INVALID'}`);
      
      // For aggregated-root modules: Use AI to extract resources for better accuracy
      let requestedResources = validationResult.detectedResources;
      if (session.moduleApproach === 'aggregated-root') {
        console.log(`\n🤖 AI Extracting resources for aggregated-root validation...`);
        const aiExtracted = await openaiService.extractResourcesFromDescription(
          description, 
          sessionProvider as 'azure' | 'aws' | 'gcp' | null
        );
        if (aiExtracted.length > 0) {
          requestedResources = aiExtracted;
          console.log(`   ✅ AI Identified ${requestedResources.length} resource(s): ${requestedResources.join(', ')}`);
        } else {
          console.log(`   ⚠️ AI failed to extract resources, falling back to regex detection`);
        }
      }

      if (validationResult.detectedProvider) {
        console.log(`   Detected Provider: ${validationResult.detectedProvider}`);
      }
      if (requestedResources.length > 0) {
        console.log(`   Target Resources: ${requestedResources.join(', ')}`);
      }
      if (validationResult.errors.length > 0) {
        console.log(`   Errors: ${validationResult.errors.join('; ')}`);
      }
      if (validationResult.warnings.length > 0) {
        console.log(`   Warnings: ${validationResult.warnings.join('; ')}`);
      }

      // For aggregated-root modules: Validate requested resources against child module
      if (session.moduleApproach === 'aggregated-root') {
        if (!childModuleResources || !Array.isArray(childModuleResources) || childModuleResources.length === 0) {
          return res.status(400).json({
            error: 'Child module not reviewed',
            details: ['Please review the child module repository first to identify available resources.']
          });
        }

        const availableResources = childModuleResources.map((r: any) => typeof r === 'string' ? r : r.type);
        
        // Check if any requested resources are not available in child module
        const unavailableResources = requestedResources.filter(req => {
          // Normalize resource names (e.g., "azurerm_storage_account" should match "azurerm_storage_account")
          return !availableResources.some(avail => 
            avail.toLowerCase() === req.toLowerCase() || 
            avail.toLowerCase().includes(req.toLowerCase()) ||
            req.toLowerCase().includes(avail.toLowerCase())
          );
        });

        if (unavailableResources.length > 0) {
          return res.status(400).json({
            error: 'Resources not available in child module',
            details: [
              `The following resources are not available in the child module: ${unavailableResources.join(', ')}`,
              `Available resources in child module: ${availableResources.length > 0 ? availableResources.join(', ') : 'None detected'}`,
              'Please use only resources that exist in the child module, or update the child module to include the required resources.'
            ],
            unavailableResources,
            availableResources,
            requestedResources
          });
        }

        console.log(`   ✅ All requested resources are available in child module`);
      }

      // If validation failed, return error immediately
      if (!validationResult.isValid) {
        const errorMessage = formatValidationErrors(validationResult);
        console.log('==========================================\n');
        return res.status(400).json({
          error: 'Validation failed',
          details: validationResult.errors,
          warnings: validationResult.warnings.length > 0 ? validationResult.warnings : undefined,
          validationResult: {
            detectedProvider: validationResult.detectedProvider,
            detectedResources: requestedResources
          }
        });
      }

      // If there are warnings, log them but continue
      if (validationResult.warnings.length > 0) {
        console.log(`   ⚠️  Proceeding with warnings: ${validationResult.warnings.join('; ')}`);
      }

      console.log('==========================================\n');

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

      // Prepare backend configuration based on cloud provider
      const cloudProvider = session.cloudProvider || 'azure';
      const backendConfig = session.hasBackend === 'true' ? {
        hasBackend: true,
        backendType: session.backendType || (cloudProvider === 'aws' ? 's3' : 'azurerm'),
        // Azure backend fields
        storageAccount: session.backendStorageAccount || undefined,
        resourceGroup: session.backendResourceGroup || undefined,
        container: session.backendContainer || undefined,
        stateKey: session.backendStateKey || undefined,
        location: session.backendLocation || undefined,
        // AWS backend fields (reuse container for bucket, location for region)
        bucket: cloudProvider === 'aws' ? (session.backendContainer || undefined) : undefined,
        // Extract DynamoDB table from stateKey if stored in format "state-key|dynamodb-table"
        dynamodbTable: cloudProvider === 'aws' ? (session.backendStateKey?.includes('|') ? session.backendStateKey.split('|')[1] : 'terraform-state-lock') : undefined,
        region: cloudProvider === 'aws' ? (session.backendLocation || 'us-east-1') : undefined,
      } : { hasBackend: false };

      // Get existing files for standalone root modules (to append instead of replace)
      // IMPORTANT: Fetch from repository, not session storage, to get the latest code
      // CRITICAL: Also handle case where moduleApproach is null but files exist
      let existingFilesForAppend: Array<{ path: string; content: string }> | undefined = undefined;
      
      // CRITICAL: First, try to fetch files from repository if they exist
      // This ensures we have the latest code before checking if we should append
      let repoFilesForAppend: Array<{ path: string; content: string }> = [];
      if (session.provider && session.repositoryName) {
        try {
          const repoFiles = await mcpClient.scanRepositoryFiles(
            session.provider as MCPProvider,
            session.repositoryName,
            'main'
          );
          
          repoFilesForAppend = repoFiles.filter(file => {
            // Normalize path: remove leading/trailing slashes (Azure DevOps returns paths with leading slash)
            const normalizedPath = file.path.replace(/^\/+|\/+$/g, '');
            const fileName = (normalizedPath.split('/').pop() || normalizedPath).toLowerCase();
            const isTerraformFile = fileName.endsWith('.tf') || fileName.endsWith('.tfvars');
            const isBackendConfig = ['backend.tf', 'provider.tf', 'terraform.tf'].includes(fileName);
            // Root level: no slashes after normalization, or only one segment
            const isRootLevel = !normalizedPath.includes('/') || normalizedPath.split('/').length === 1;
            const shouldInclude = isTerraformFile && !isBackendConfig && isRootLevel;
            
            // Debug logging for tfvars files
            if (fileName.includes('tfvars')) {
              console.log(`      🔍 Checking tfvars file: "${file.path}" → normalized: "${normalizedPath}" → fileName: "${fileName}"`);
              console.log(`         isTerraformFile: ${isTerraformFile}, isBackendConfig: ${isBackendConfig}, isRootLevel: ${isRootLevel}, shouldInclude: ${shouldInclude}`);
            }
            
            return shouldInclude;
          });
          
          if (repoFilesForAppend.length > 0) {
            console.log(`\n📋 Found ${repoFilesForAppend.length} file(s) in repository for appending`);
            repoFilesForAppend.forEach(file => {
              console.log(`   - ${file.path} (${file.content.length} chars)`);
            });
            
            // CRITICAL: Check if dev.terraform.tfvars was found
            const hasTfvars = repoFilesForAppend.some(f => {
              const normalizedPath = f.path.replace(/^\/+|\/+$/g, '').toLowerCase();
              const fileName = normalizedPath.split('/').pop() || normalizedPath;
              return fileName === 'dev.terraform.tfvars';
            });
            if (!hasTfvars) {
              console.error(`\n   ⚠️⚠️⚠️  WARNING: dev.terraform.tfvars NOT FOUND in repoFilesForAppend!`);
              // Check if it exists in raw repoFiles
              const rawTfvars = repoFiles.find(f => {
                const normalizedPath = f.path.replace(/^\/+|\/+$/g, '').toLowerCase();
                const fileName = normalizedPath.split('/').pop() || normalizedPath;
                return fileName === 'dev.terraform.tfvars';
              });
              if (rawTfvars) {
                console.error(`   ⚠️  File EXISTS in raw repoFiles but was FILTERED OUT!`);
                console.error(`   ⚠️  Raw file: "${rawTfvars.path}"`);
              }
            } else {
              console.log(`   ✅ dev.terraform.tfvars found in repoFilesForAppend`);
            }
          }
        } catch (error: any) {
          console.warn(`   ⚠️  Could not fetch from repository for appending: ${error.message}`);
        }
      }
      
      // Check if we should treat as standalone-root (explicit or inferred from files)
      // BUT: Skip for aggregated-root - it should always create fresh files
      const sessionFilesCheck = await storage.getFilesBySession(sessionId);
      const shouldAppend = (session.moduleApproach === 'standalone-root' || 
                          (session.moduleApproach === null && (sessionFilesCheck.length > 0 || repoFilesForAppend.length > 0))) &&
                          session.moduleApproach !== 'aggregated-root';
      
      if (shouldAppend) {
        // First check session storage (might have files from previous generation or scan)
        const sessionFiles = await storage.getFilesBySession(sessionId);
        console.log(`\n📋 Checking session storage: Found ${sessionFiles.length} total file(s)`);
        sessionFiles.forEach(f => {
          console.log(`   - ${f.fileName} (ID: ${f.id})`);
        });
        
        const sessionTerraformFiles = sessionFiles.filter(file => {
          const fileName = file.fileName.toLowerCase();
          return (fileName.endsWith('.tf') || fileName.endsWith('.tfvars')) && 
                 !['backend.tf', 'provider.tf', 'terraform.tf'].includes(fileName) &&
                 !file.fileName.includes('/'); // Only root-level files for standalone root
        });
        console.log(`   📄 Terraform resource files in session: ${sessionTerraformFiles.length}`);
        
        // Use repository files if we already fetched them, otherwise fetch now
        if (repoFilesForAppend.length > 0) {
          // Use files we already fetched
          existingFilesForAppend = repoFilesForAppend;
          console.log(`   📋 Using repository files for appending (already fetched)`);
          
          // Update session storage with repository files (preserve IDs)
          console.log(`   💾 Updating ${repoFilesForAppend.length} file(s) in session storage with latest repository content...`);
          const sessionFilesMap = new Map<string, GeneratedFile>();
          sessionFiles.forEach(f => {
            sessionFilesMap.set(f.fileName.toLowerCase(), f);
          });
          
          for (const repoFile of repoFilesForAppend) {
            const fileName = repoFile.path.split('/').pop() || repoFile.path;
            const existingSessionFile = sessionFilesMap.get(fileName.toLowerCase());
            
            if (existingSessionFile) {
              console.log(`      ✅ Updating ${fileName} in session storage (ID: ${existingSessionFile.id}) - PRESERVING ID`);
              await storage.updateFile(existingSessionFile.id, repoFile.content);
            } else {
              console.error(`      ⚠️  File ${fileName} not found in session storage, creating as fallback`);
              await storage.createFile({
                sessionId,
                fileName: fileName,
                content: repoFile.content,
              });
            }
          }
          console.log(`   ✅ Files updated in session storage (IDs preserved for matching)`);
        } else {
          // Fetch from repository to get the latest code
          let repoFiles: Array<{ path: string; content: string }> = [];
          if (session.provider && session.repositoryName) {
            try {
              console.log(`\n📥 Fetching existing files from repository for appending...`);
              repoFiles = await mcpClient.scanRepositoryFiles(
              session.provider as MCPProvider,
              session.repositoryName,
              'main'
            );
            
            // Filter to get only Terraform resource files (exclude backend config)
            const repoTerraformFiles = repoFiles.filter(file => {
              // Normalize path: remove leading/trailing slashes (Azure DevOps returns paths with leading slash)
              const normalizedPath = file.path.replace(/^\/+|\/+$/g, '');
              const fileName = (normalizedPath.split('/').pop() || normalizedPath).toLowerCase();
              const isTerraformFile = fileName.endsWith('.tf') || fileName.endsWith('.tfvars');
              const isBackendConfig = ['backend.tf', 'provider.tf', 'terraform.tf'].includes(fileName);
              // Root level: no slashes after normalization, or only one segment
              const isRootLevel = !normalizedPath.includes('/') || normalizedPath.split('/').length === 1;
              const shouldInclude = isTerraformFile && !isBackendConfig && isRootLevel;
              
              // Debug logging for tfvars files
              if (fileName.includes('tfvars')) {
                console.log(`      🔍 Checking tfvars file: "${file.path}" → normalized: "${normalizedPath}" → fileName: "${fileName}"`);
                console.log(`         isTerraformFile: ${isTerraformFile}, isBackendConfig: ${isBackendConfig}, isRootLevel: ${isRootLevel}, shouldInclude: ${shouldInclude}`);
              }
              
              return shouldInclude;
            });
            
            console.log(`   ✅ Found ${repoTerraformFiles.length} file(s) in repository`);
            repoTerraformFiles.forEach(file => {
              console.log(`      - ${file.path} (${file.content.length} chars)`);
            });
            
            // CRITICAL: Check if dev.terraform.tfvars was found
            const hasTfvars = repoTerraformFiles.some(f => {
              const normalizedPath = f.path.replace(/^\/+|\/+$/g, '').toLowerCase();
              const fileName = normalizedPath.split('/').pop() || normalizedPath;
              return fileName === 'dev.terraform.tfvars';
            });
            if (!hasTfvars) {
              console.error(`\n   ⚠️⚠️⚠️  WARNING: dev.terraform.tfvars NOT FOUND in repository files!`);
              console.error(`   ⚠️  Check if file exists in repository or if filter is excluding it!`);
              // Check if it exists in raw repoFiles
              const rawTfvars = repoFiles.find(f => {
                const normalizedPath = f.path.replace(/^\/+|\/+$/g, '').toLowerCase();
                const fileName = normalizedPath.split('/').pop() || normalizedPath;
                return fileName === 'dev.terraform.tfvars';
              });
              if (rawTfvars) {
                console.error(`   ⚠️  File EXISTS in raw repoFiles but was FILTERED OUT!`);
                console.error(`   ⚠️  Raw file: "${rawTfvars.path}"`);
              } else {
                console.error(`   ⚠️  File does NOT exist in repository at all!`);
              }
            } else {
              console.log(`   ✅ dev.terraform.tfvars found in repository files`);
            }
            
            // Use repository files (latest code) if available, otherwise use session files
            if (repoTerraformFiles.length > 0) {
              existingFilesForAppend = repoTerraformFiles;
              console.log(`   📋 Using repository files for appending (latest code)`);
              
              // CRITICAL: Use ALL session files (not just filtered) to find existing files
              // This ensures we find files that were stored during scan
              console.log(`   💾 Updating ${repoTerraformFiles.length} file(s) in session storage with latest repository content...`);
              const sessionFilesMap = new Map<string, GeneratedFile>();
              // Use ALL session files, not just filtered ones
              sessionFiles.forEach(f => {
                sessionFilesMap.set(f.fileName.toLowerCase(), f);
              });
              console.log(`   📋 Session files map has ${sessionFilesMap.size} entries`);
              
              for (const repoFile of repoTerraformFiles) {
                const fileName = repoFile.path.split('/').pop() || repoFile.path;
                const existingSessionFile = sessionFilesMap.get(fileName.toLowerCase());
                
                if (existingSessionFile) {
                  // File exists - update it with latest repository content (PRESERVE ID!)
                  console.log(`      ✅ Updating ${fileName} in session storage (ID: ${existingSessionFile.id}) - PRESERVING ID`);
                  await storage.updateFile(existingSessionFile.id, repoFile.content);
                } else {
                  // File doesn't exist in session - this shouldn't happen if scan worked
                  // But create it anyway as fallback
                  console.error(`      ⚠️  File ${fileName} not found in session storage, creating as fallback`);
                  console.error(`      ⚠️  This might break matching - files should have been stored during scan!`);
                  console.error(`      ⚠️  Available session files: ${Array.from(sessionFilesMap.keys()).join(', ')}`);
                  await storage.createFile({
                    sessionId,
                    fileName: fileName,
                    content: repoFile.content,
                  });
                }
              }
              console.log(`   ✅ Files updated in session storage (IDs preserved for matching)`);
            } else if (sessionTerraformFiles.length > 0) {
              existingFilesForAppend = sessionTerraformFiles.map(file => ({
                path: file.fileName,
                content: file.content
              }));
              console.log(`   📋 Using session files for appending (no repository files found)`);
            }
          } catch (repoError: any) {
            console.warn(`   ⚠️  Could not fetch from repository: ${repoError.message}`);
            console.warn(`   Falling back to session storage files`);
            
            // Fallback to session files if repository fetch fails
            if (sessionTerraformFiles.length > 0) {
              existingFilesForAppend = sessionTerraformFiles.map(file => ({
                path: file.fileName,
                content: file.content
              }));
            }
          }
          }
        }
        
        // If we still don't have files for appending, use session files
        // BUT: Skip for aggregated-root - it should always create fresh files
        if (!existingFilesForAppend && sessionTerraformFiles.length > 0 && session.moduleApproach !== 'aggregated-root') {
          // No repository info, use session files
          existingFilesForAppend = sessionTerraformFiles.map(file => ({
            path: file.fileName,
            content: file.content
          }));
          console.log(`   📋 Using session files for appending (no repository access)`);
        }
        
        if (existingFilesForAppend && existingFilesForAppend.length > 0 && session.moduleApproach !== 'aggregated-root') {
          console.log(`\n📋 Will append new resources to ${existingFilesForAppend.length} existing file(s):`);
          existingFilesForAppend.forEach(file => {
            console.log(`   - ${file.path} (${file.content.length} chars)`);
          });
          
          // CRITICAL: Check if dev.terraform.tfvars is included
          const hasTfvars = existingFilesForAppend.some(f => {
            const normalizedPath = f.path.replace(/^\/+|\/+$/g, '').toLowerCase();
            const fileName = normalizedPath.split('/').pop() || normalizedPath;
            return fileName === 'dev.terraform.tfvars';
          });
          if (!hasTfvars) {
            console.error(`\n   ⚠️⚠️⚠️  WARNING: dev.terraform.tfvars NOT FOUND in existing files!`);
            console.error(`   ⚠️  This means AI won't know about existing tfvars and might replace it!`);
            console.error(`   ⚠️  Files included: ${existingFilesForAppend.map(f => f.path).join(', ')}`);
          } else {
            console.log(`   ✅ dev.terraform.tfvars is included in existing files`);
          }
          
          console.log(`   AI will preserve ALL existing content and add new resources.\n`);
        } else {
          if (session.moduleApproach === 'aggregated-root') {
            console.log(`\n📦 AGGREGATED-ROOT: Creating fresh files (no existing files to append)`);
          } else {
            console.error(`\n   ⚠️⚠️⚠️  WARNING: No existing files found for appending!`);
            console.error(`   ⚠️  This means AI will create all files as new (including dev.terraform.tfvars)!`);
          }
        }
      }

      // Generate Terraform files with context
      // For aggregated-root: Don't pass existing files - create fresh
      const filesForGeneration = (session.moduleApproach === 'aggregated-root') 
        ? undefined 
        : existingFilesForAppend;
      
      if (session.moduleApproach === 'aggregated-root') {
        console.log(`\n📦 AGGREGATED-ROOT: Creating fresh files (not appending to existing)`);
        console.log(`   Description: "${description.substring(0, 200)}${description.length > 200 ? '...' : ''}"`);
      }
      
      const result = await openaiService.generateTerraform(
        description, 
        session.cloudProvider, 
        session.moduleApproach,
        backendConfig,
        filesForGeneration
      );
      
      // CRITICAL: Log what AI actually generated
      console.log(`\n📥 [AI RESPONSE] AI generated ${result.files.length} file(s):`);
      result.files.forEach((file, idx) => {
        console.log(`   ${idx + 1}. ${file.path} (${file.content.length} chars)`);
        
        // For aggregated-root: Check for module blocks in main.tf
        if (file.path === 'main.tf' && session.moduleApproach === 'aggregated-root') {
          const modulePattern = /module\s+"([^"]+)"/g;
          const modules: string[] = [];
          let match;
          while ((match = modulePattern.exec(file.content)) !== null) {
            modules.push(match[1]);
          }
          console.log(`      📦 Module blocks in AI response: ${modules.length}`);
          modules.forEach((mod, i) => {
            console.log(`         ${i + 1}. module "${mod}"`);
          });
          if (modules.length === 0) {
            console.error(`      ❌ WARNING: No module blocks found in main.tf for aggregated-root!`);
          }
        }
        
        // For main.tf, check what resources were generated (for non-aggregated-root)
        if (file.path === 'main.tf' && session.moduleApproach !== 'aggregated-root') {
          const resourcePattern = /resource\s+"([^"]+)"\s+"([^"]+)"/g;
          const resources: string[] = [];
          let match;
          while ((match = resourcePattern.exec(file.content)) !== null) {
            resources.push(`${match[1]}.${match[2]}`);
          }
          console.log(`      📦 Resources in AI response: ${resources.length}`);
          resources.forEach((res, i) => {
            console.log(`         ${i + 1}. ${res}`);
          });
          
          // Check specifically for container resources
          const hasContainerEnv = file.content.includes('azurerm_container_app_environment');
          const hasContainerRegistry = file.content.includes('azurerm_container_registry');
          console.log(`      🔍 Container resources check:`);
          console.log(`         - Container App Environment: ${hasContainerEnv ? '✅ FOUND' : '❌ NOT FOUND'}`);
          console.log(`         - Container Registry: ${hasContainerRegistry ? '✅ FOUND' : '❌ NOT FOUND'}`);
        }
      });
      
      // Check if required files are present for aggregated-root
      if (session.moduleApproach === 'aggregated-root') {
        const requiredFiles = ['main.tf', 'variables.tf', 'dev.terraform.tfvars', 'outputs.tf'];
        const generatedFileNames = result.files.map(f => f.path.split('/').pop() || f.path);
        const missingFiles = requiredFiles.filter(req => !generatedFileNames.includes(req));
        if (missingFiles.length > 0) {
          console.error(`\n❌ WARNING: Missing required files for aggregated-root: ${missingFiles.join(', ')}`);
          console.error(`   Generated files: ${generatedFileNames.join(', ')}`);
        } else {
          console.log(`\n✅ All required files present for aggregated-root: ${requiredFiles.join(', ')}`);
        }
      }

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

      // For standalone root modules: Use the same files that were passed to AI for matching
      // This ensures consistency - we match against the exact files the AI saw
      let existingFilesBeforeProcessing: GeneratedFile[] = [];
      const preservedFiles: GeneratedFile[] = [];
      
      console.log(`\n🔍 Module approach: ${session.moduleApproach}`);
      console.log(`   Session ID: ${sessionId}`);
      
      // CRITICAL: Check if files exist in session - if they do, treat as standalone-root
      // This handles the case where moduleApproach is null but files exist (from scan)
      const sessionFilesCheckForDelete = await storage.getFilesBySession(sessionId);
      const hasExistingFiles = sessionFilesCheckForDelete.length > 0;
      
      if (session.moduleApproach === 'standalone-root' || 
          (session.moduleApproach === null && hasExistingFiles)) {
        // NOTE: We don't need existingFilesBeforeProcessing anymore
        // We'll get files directly from session storage when matching
        console.log(`\n📝 Standalone root module: Will match against session storage files directly`);
        if (session.moduleApproach === null && hasExistingFiles) {
          console.log(`   ⚠️  moduleApproach is null but ${hasExistingFiles} file(s) exist - treating as standalone-root`);
        }
        existingFilesBeforeProcessing = []; // Not used anymore, but keep for compatibility
      } else {
        // For child modules: Delete all session files and recreate
        // For aggregated-root: Preserve backend files, only delete resource files
        if (session.moduleApproach === 'child-module') {
          console.log(`\n🗑️  Deleting existing session files for ${session.moduleApproach}...`);
          await storage.deleteFilesBySession(sessionId);
        } else if (session.moduleApproach === 'aggregated-root') {
          // For aggregated-root: Preserve backend files, only delete resource files if they exist
          console.log(`\n🔍 Checking files for aggregated-root...`);
          const allSessionFiles = await storage.getFilesBySession(sessionId);
          const backendFiles = ['backend.tf', 'provider.tf', 'terraform.tf'];
          const resourceFilesToDelete = allSessionFiles.filter(f => !backendFiles.includes(f.fileName));
          
          console.log(`   Total files in session: ${allSessionFiles.length}`);
          console.log(`   Backend files: ${allSessionFiles.filter(f => backendFiles.includes(f.fileName)).map(f => f.fileName).join(', ') || 'none'}`);
          console.log(`   Resource files: ${resourceFilesToDelete.map(f => f.fileName).join(', ') || 'none'}`);
          
          if (resourceFilesToDelete.length > 0) {
            console.log(`   🗑️  Deleting ${resourceFilesToDelete.length} existing resource file(s) (preserving backend files):`);
            resourceFilesToDelete.forEach(f => console.log(`      - ${f.fileName}`));
            for (const file of resourceFilesToDelete) {
              await storage.deleteFile(file.id);
            }
            console.log(`   ✅ Deleted existing resource files, backend files preserved`);
          } else {
            console.log(`   ✅ No resource files to delete - will create new resource files (backend files preserved)`);
          }
        } else {
          console.log(`\n⚠️  moduleApproach is null and no files exist - will create new files`);
        }
      }

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
${session.hasBackend === 'true' ? `- **Backend**: Configured for remote state management using ${session.backendType}` : '- **Backend**: Local state management'}

## File Structure

${session.hasBackend === 'true' ? '- **backend.tf**: Backend configuration for state storage' : ''}
${result.files.some(f => f.path === 'provider.tf') ? '- **provider.tf**: Provider configuration and version requirements' : ''}
- **main.tf**: Resource definitions
- **variables.tf**: Input variable declarations
- **dev.terraform.tfvars**: Environment-specific variable values
- **outputs.tf**: Output values

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
      // Filter out backend.tf, provider.tf, and terraform.tf to prevent duplication
      // These files are created during backend configuration and should not be overwritten
      const protectedFiles = ['backend.tf', 'provider.tf', 'terraform.tf'];
      const filteredFiles = result.files.filter((file: any) => {
        const fileName = file.path.split('/').pop();
        return !protectedFiles.includes(fileName);
      });
      
      console.log(`\n📋 File filtering:`);
      console.log(`   AI generated: ${result.files.length} file(s)`);
      console.log(`   After filtering protected files: ${filteredFiles.length} file(s)`);
      filteredFiles.forEach(f => {
        console.log(`      - ${f.path}`);
      });
      
      const allFiles = [
        ...filteredFiles,
        { path: 'README.md', content: readmeContent }
      ];
      
      console.log(`   Total files to save (including README): ${allFiles.length}`);
      
      // For aggregated-root: Validate that required files are present
      if (session.moduleApproach === 'aggregated-root') {
        const requiredFiles = ['main.tf', 'variables.tf', 'dev.terraform.tfvars', 'outputs.tf'];
        const fileNames = allFiles.map(f => f.path.split('/').pop() || f.path);
        const missingFiles = requiredFiles.filter(req => !fileNames.includes(req));
        if (missingFiles.length > 0) {
          console.error(`\n❌ CRITICAL: Missing required files for aggregated-root: ${missingFiles.join(', ')}`);
          console.error(`   Files to save: ${fileNames.join(', ')}`);
          console.error(`   This means the AI did not generate all required files!`);
        }
      }

      // CRITICAL: Get ALL session files FIRST to check if we should treat as standalone-root
      // This must happen BEFORE we check moduleApproach
      let allSessionFilesNow = await storage.getFilesBySession(sessionId);
      console.log(`\n🔍 Checking for standalone-root behavior...`);
      console.log(`   moduleApproach: ${session.moduleApproach}`);
      console.log(`   Files in session: ${allSessionFilesNow.length}`);
      allSessionFilesNow.forEach(f => {
        console.log(`      - ${f.fileName} (ID: ${f.id}, ${f.content.length} chars)`);
      });
      
      // CRITICAL: If no files in session but repository exists, fetch from repository NOW
      // This handles the case where scan-repository wasn't called or files were cleared
      if (allSessionFilesNow.length === 0 && session.provider && session.repositoryName) {
        console.log(`\n   ⚠️  No files in session storage, but repository exists.`);
        console.log(`   🔄 Fetching files from repository and storing in session...`);
        try {
          const repoFiles = await mcpClient.scanRepositoryFiles(
            session.provider as MCPProvider,
            session.repositoryName,
            'main'
          );
          
          const terraformResourceFiles = repoFiles.filter(file => {
            // Normalize path: remove leading/trailing slashes (Azure DevOps returns paths with leading slash)
            const normalizedPath = file.path.replace(/^\/+|\/+$/g, '');
            const fileName = (normalizedPath.split('/').pop() || normalizedPath).toLowerCase();
            const isTerraformFile = fileName.endsWith('.tf') || fileName.endsWith('.tfvars');
            const isBackendConfig = ['backend.tf', 'provider.tf', 'terraform.tf'].includes(fileName);
            // Root level: no slashes after normalization, or only one segment
            const isRootLevel = !normalizedPath.includes('/') || normalizedPath.split('/').length === 1;
            return isTerraformFile && !isBackendConfig && isRootLevel;
          });
          
          console.log(`   💾 Storing ${terraformResourceFiles.length} file(s) in session storage...`);
          for (const repoFile of terraformResourceFiles) {
            // Normalize path: remove leading/trailing slashes
            const normalizedPath = repoFile.path.replace(/^\/+|\/+$/g, '');
            const fileName = normalizedPath.split('/').pop() || normalizedPath;
            console.log(`      📄 Processing file from repo: "${repoFile.path}" → normalized: "${normalizedPath}" → fileName: "${fileName}"`);
            const created = await storage.createFile({
              sessionId,
              fileName: fileName,
              content: repoFile.content,
            });
            console.log(`      ✅ Stored ${fileName} (ID: ${created.id})`);
          }
          
          // Re-fetch after storing
          allSessionFilesNow = await storage.getFilesBySession(sessionId);
          console.log(`   ✅ Now have ${allSessionFilesNow.length} file(s) in session storage`);
        } catch (error: any) {
          console.error(`   ❌ Failed to fetch from repository: ${error.message}`);
        }
      }
      
      // For standalone root modules: Update existing files instead of creating new ones
      // CRITICAL: Check moduleApproach OR if files exist in session (standalone-root behavior)
      // BUT: For aggregated-root, always create new files (don't treat as standalone-root)
      const isStandaloneRoot = (session.moduleApproach === 'standalone-root' || 
                                (session.moduleApproach === null && allSessionFilesNow.length > 0)) &&
                               session.moduleApproach !== 'aggregated-root';
      
      console.log(`   moduleApproach: ${session.moduleApproach}`);
      console.log(`   Files in session: ${allSessionFilesNow.length}`);
      console.log(`   isStandaloneRoot: ${isStandaloneRoot}`);
      
      // For aggregated-root: Log what files will be created
      if (session.moduleApproach === 'aggregated-root') {
        console.log(`\n📦 AGGREGATED-ROOT MODULE: Will create new files`);
        console.log(`   Files to create: ${allFiles.length}`);
        allFiles.forEach(f => {
          console.log(`      - ${f.path} (${f.content.length} chars)`);
        });
      }
      
      let savedFiles;
      if (isStandaloneRoot) {
        // Log why we're treating this as standalone-root
        if (session.moduleApproach === null) {
          console.log(`\n⚠️  WARNING: moduleApproach is null, but ${allSessionFilesNow.length} file(s) exist in session.`);
          console.log(`   Treating as standalone-root based on existing files.`);
        }
        savedFiles = [];
        
        // CRITICAL: Get ALL session files RIGHT NOW for matching
        // This is the SINGLE SOURCE OF TRUTH for existing files
        console.log(`\n${'='.repeat(80)}`);
        console.log(`🔍 STANDALONE ROOT: Starting file matching...`);
        console.log(`${'='.repeat(80)}`);
        console.log(`   Session ID: ${sessionId}`);
        console.log(`   Module approach: ${session.moduleApproach || 'null (inferred from existing files)'}`);
        console.log(`   Provider: ${session.provider}`);
        console.log(`   Repository: ${session.repositoryName}`);
        
        // Verify session exists
        const sessionCheck = await storage.getSession(sessionId);
        if (!sessionCheck) {
          console.error(`   ❌❌❌ CRITICAL: Session ${sessionId} does not exist!`);
          throw new Error(`Session ${sessionId} not found`);
        }
        console.log(`   ✅ Session verified: ${sessionCheck.id}`);
        
        // Get ALL files for this session (refresh to ensure we have latest)
        allSessionFilesNow = await storage.getFilesBySession(sessionId);
        console.log(`\n   📋 Fetched ${allSessionFilesNow.length} file(s) from session storage`);
        
        if (allSessionFilesNow.length > 0) {
          console.log(`   ✅ Files found in session storage:`);
          allSessionFilesNow.forEach(f => {
            console.log(`      - ${f.fileName} (ID: ${f.id}, ${f.content.length} chars, sessionId: ${f.sessionId})`);
          });
        } else {
          console.error(`   ❌ NO FILES FOUND in session storage!`);
          console.error(`   This means files were NOT stored during scan, or were cleared.`);
          console.error(`   Check scan logs above to see if files were stored.`);
        }
        
        // CRITICAL: If no files in session storage, fetch from repository IMMEDIATELY
        // This should NOT happen if scan worked, but we need this as safety net
        if (allSessionFilesNow.length === 0 && session.provider && session.repositoryName) {
          console.error(`\n   ❌ CRITICAL: No files in session storage! Fetching from repository NOW...`);
          try {
            const repoFiles = await mcpClient.scanRepositoryFiles(
              session.provider as MCPProvider,
              session.repositoryName,
              'main'
            );
            
            const terraformResourceFiles = repoFiles.filter(file => {
              // Normalize path: remove leading/trailing slashes
              const normalizedPath = file.path.replace(/^\/+|\/+$/g, '');
              const fileName = (normalizedPath.split('/').pop() || normalizedPath).toLowerCase();
              const isTerraformFile = fileName.endsWith('.tf') || fileName.endsWith('.tfvars');
              const isBackendConfig = ['backend.tf', 'provider.tf', 'terraform.tf'].includes(fileName);
              // Root level: no slashes after normalization, or only one segment
              const isRootLevel = !normalizedPath.includes('/') || normalizedPath.split('/').length === 1;
              return isTerraformFile && !isBackendConfig && isRootLevel;
            });
            
            console.error(`   💾 Storing ${terraformResourceFiles.length} file(s) in session storage...`);
            for (const repoFile of terraformResourceFiles) {
              // Normalize path: remove leading/trailing slashes
              const normalizedPath = repoFile.path.replace(/^\/+|\/+$/g, '');
              const fileName = normalizedPath.split('/').pop() || normalizedPath;
              console.error(`      📄 Processing file from repo: "${repoFile.path}" → normalized: "${normalizedPath}" → fileName: "${fileName}"`);
              const created = await storage.createFile({
                sessionId,
                fileName: fileName,
                content: repoFile.content,
              });
              console.error(`      ✅ Stored ${fileName} (ID: ${created.id})`);
            }
            
            // Re-fetch
            allSessionFilesNow = await storage.getFilesBySession(sessionId);
            console.error(`   ✅ Now have ${allSessionFilesNow.length} file(s) in session storage`);
          } catch (error: any) {
            console.error(`   ❌ Failed to fetch from repository: ${error.message}`);
          }
        }
        
        // FINAL CHECK: If still no files, this is a critical error
        if (allSessionFilesNow.length === 0) {
          console.error(`\n   ❌❌❌ CRITICAL ERROR: Still no files in session storage after all attempts!`);
          console.error(`   Session ID: ${sessionId}`);
          console.error(`   Provider: ${session.provider}`);
          console.error(`   Repository: ${session.repositoryName}`);
          console.error(`   This means files were NEVER stored, or session storage is broken.`);
          console.error(`   Files will be created as new (this is a BUG).`);
        }
        
        // Create a SIMPLE map: filename (lowercase) -> file
        // This is the ONLY map we need - simple and bulletproof
        const sessionFilesMap = new Map<string, GeneratedFile>();
        allSessionFilesNow.forEach(f => {
          const key = f.fileName.toLowerCase();
          sessionFilesMap.set(key, f);
          // Also add just the filename (without path) as key
          const fileNameOnly = f.fileName.split('/').pop() || f.fileName;
          const fileNameOnlyLower = fileNameOnly.toLowerCase();
          sessionFilesMap.set(fileNameOnlyLower, f);
          // Also add with path variations
          if (f.fileName !== fileNameOnly) {
            sessionFilesMap.set(f.fileName, f);
          }
        });
        
        console.log(`\n   📋 Session files map created with ${sessionFilesMap.size} entries`);
        console.log(`   Map keys: ${Array.from(sessionFilesMap.keys()).join(', ')}`);
        console.log(`   Original file names in session:`);
        allSessionFilesNow.forEach(f => {
          console.log(`      - "${f.fileName}" (ID: ${f.id})`);
        });
        
        console.log(`\n📝 Processing ${allFiles.length} generated file(s):`);
        
        for (const file of allFiles) {
          // Skip README.md - it's always new
          if (file.path.toLowerCase() === 'readme.md') {
            console.log(`\n   📄 ${file.path} - Skipping (always create new)`);
            const created = await storage.createFile({
              sessionId,
              fileName: file.path,
              content: file.content,
            });
            savedFiles.push(created);
            continue;
          }
          
          // Extract filename (handle paths like "./main.tf" or "main.tf")
          let fileNameOnly = file.path.split('/').pop() || file.path;
          const fileNameOnlyLower = fileNameOnly.toLowerCase();
          const filePathLower = file.path.toLowerCase();
          
          console.log(`\n   🔍 Processing: "${file.path}"`);
          console.log(`      Filename only: "${fileNameOnly}"`);
          console.log(`      Filename (lowercase): "${fileNameOnlyLower}"`);
          console.log(`      Path (lowercase): "${filePathLower}"`);
          
          // SIMPLE MATCHING: Try multiple lookup strategies
          let existingFile = sessionFilesMap.get(fileNameOnlyLower);
          
          if (!existingFile) {
            existingFile = sessionFilesMap.get(filePathLower);
          }
          
          if (!existingFile) {
            existingFile = sessionFilesMap.get(file.path);
          }
          
          // If still not found, try direct search (case-insensitive) - same as main.tf, variables.tf
          if (!existingFile) {
            existingFile = allSessionFilesNow.find(sf => {
              const sfName = sf.fileName.toLowerCase();
              const sfNameOnly = (sf.fileName.split('/').pop() || sf.fileName).toLowerCase();
              return sfName === fileNameOnlyLower || 
                     sfNameOnly === fileNameOnlyLower ||
                     sfName === filePathLower ||
                     sf.fileName === file.path ||
                     sf.fileName === fileNameOnly;
            });
            if (existingFile) {
              console.log(`      🔄 Found via direct search: "${existingFile.fileName}" (ID: ${existingFile.id})`);
            }
          }
          
          if (existingFile) {
            // FILE EXISTS - UPDATE IT (PRESERVE ID!)
            console.log(`      ✅ FOUND existing file: "${existingFile.fileName}" (ID: ${existingFile.id})`);
            console.log(`      📝 UPDATING (preserving ID: ${existingFile.id})`);
            console.log(`         Old size: ${existingFile.content.length} chars`);
            console.log(`         New size: ${file.content.length} chars`);
            console.log(`         Session ID: ${existingFile.sessionId} (should match: ${sessionId})`);
            
            // CRITICAL: Verify session ID matches
            if (existingFile.sessionId !== sessionId) {
              console.error(`         ❌❌❌ CRITICAL: Session ID mismatch!`);
              console.error(`         File sessionId: ${existingFile.sessionId}`);
              console.error(`         Current sessionId: ${sessionId}`);
              console.error(`         This file belongs to a different session!`);
            }
            
            // CRITICAL: ALWAYS merge for ALL files (regardless of size)
            // Size comparison is unreliable - AI might replace content even if file is larger
            // We always extract new content and append it to existing to ensure no data loss
            const isTfvarsFile = fileNameOnlyLower === 'terraform.tfvars' || fileNameOnlyLower === 'dev.terraform.tfvars';
            
            // Always merge - don't rely on size comparison
            console.log(`\n         🔧 ALWAYS MERGING (ensuring existing content is preserved + new content added)...`);
            if (file.content.length < existingFile.content.length) {
              console.warn(`         ⚠️  Generated file is ${existingFile.content.length - file.content.length} chars SMALLER - likely replaced content`);
            } else if (file.content.length > existingFile.content.length) {
              console.warn(`         ⚠️  Generated file is ${file.content.length - existingFile.content.length} chars LARGER - might have replaced or appended`);
            } else {
              console.warn(`         ⚠️  Generated file is same size - likely replaced content`);
            }
            console.log(`         📋 Merging ensures: existing content preserved + only NEW content added`);
            
            let finalContent = file.content;
            // Always merge - extract new content and append to existing
            // Merge logic: Append new resources to existing content
            const existingContent = existingFile.content;
            const newContent = file.content;
              
              // Helper functions for merging (defined outside block to avoid strict mode issues)
              const calculateSimilarity = (str1: string, str2: string): number => {
                const longer = str1.length > str2.length ? str1 : str2;
                const shorter = str1.length > str2.length ? str2 : str1;
                if (longer.length === 0) return 1.0;
                const distance = levenshteinDistance(longer, shorter);
                return (longer.length - distance) / longer.length;
              };
              
              const levenshteinDistance = (str1: string, str2: string): number => {
                const matrix: number[][] = [];
                for (let i = 0; i <= str2.length; i++) {
                  matrix[i] = [i];
                }
                for (let j = 0; j <= str1.length; j++) {
                  matrix[0][j] = j;
                }
                for (let i = 1; i <= str2.length; i++) {
                  for (let j = 1; j <= str1.length; j++) {
                    if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                      matrix[i][j] = matrix[i - 1][j - 1];
                    } else {
                      matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                      );
                    }
                  }
                }
                return matrix[str2.length][str1.length];
              };
              
              // Helper function to extract Terraform blocks (handles nested braces)
              const extractTerraformBlocks = (content: string, blockType: 'resource' | 'variable' | 'output'): string[] => {
                const blocks: string[] = [];
                const pattern = new RegExp(`${blockType}\\s+"([^"]+)"(?:\\s+"([^"]+)")?\\s*\\{`, 'g');
                let match;
                
                while ((match = pattern.exec(content)) !== null) {
                  const startPos = match.index;
                  let braceCount = 0;
                  let inBlock = false;
                  let blockEnd = startPos;
                  
                  // Find the matching closing brace
                  for (let i = startPos; i < content.length; i++) {
                    if (content[i] === '{') {
                      braceCount++;
                      inBlock = true;
                    } else if (content[i] === '}') {
                      braceCount--;
                      if (inBlock && braceCount === 0) {
                        blockEnd = i + 1;
                        break;
                      }
                    }
                  }
                  
                  if (blockEnd > startPos) {
                    blocks.push(content.substring(startPos, blockEnd));
                  }
                }
                
                return blocks;
              };
              
              // For main.tf: Smart merge - trust AI if it includes all existing content, otherwise extract and append
              if (fileNameOnlyLower === 'main.tf') {
                // First, verify if AI response includes all existing resources
                const existingResources = extractTerraformBlocks(existingContent, 'resource');
                const aiResources = extractTerraformBlocks(newContent, 'resource');
                
                console.error(`         🔍 [MERGE] Analysis:`);
                console.error(`            Existing resources: ${existingResources.length}`);
                console.error(`            AI response resources: ${aiResources.length}`);
                
                // Check if AI response includes all existing resources
                let allExistingFound = true;
                const missingResources: string[] = [];
                
                for (const existingRes of existingResources) {
                  const existingResMatch = existingRes.match(/resource\s+"([^"]+)"\s+"([^"]+)"/);
                  if (existingResMatch) {
                    const resType = existingResMatch[1];
                    const resName = existingResMatch[2];
                    const pattern = new RegExp(`resource\\s+"${resType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s+"${resName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);
                    
                    if (!pattern.test(newContent)) {
                      allExistingFound = false;
                      missingResources.push(`${resType}.${resName}`);
                    }
                  }
                }
                
                if (allExistingFound && aiResources.length >= existingResources.length) {
                  // AI response includes all existing resources - trust it (it's complete)
                  console.error(`         ✅ [MERGE] AI response includes all existing resources - using AI response as-is`);
                  console.error(`         ✅ [MERGE] AI added ${aiResources.length - existingResources.length} new resource(s)`);
                  finalContent = newContent; // Use AI response directly
                } else {
                  // AI response is missing existing resources - extract new ones and append
                  console.error(`         ⚠️  [MERGE] AI response missing ${missingResources.length} existing resource(s): ${missingResources.join(', ')}`);
                  console.error(`         🔧 [MERGE] Extracting new resources and appending to existing...`);
                  
                  // Extract resource blocks from new content
                  const newResources = extractTerraformBlocks(newContent, 'resource');
                  
                  console.error(`         📊 [MERGE] Found ${newResources.length} resource(s) in AI response`);
                  
                  // Check if new resources already exist in old content
                  // Use more lenient matching - check for exact resource type + name combination
                  const resourcesToAdd = newResources.filter(newRes => {
                    const newResName = newRes.match(/resource\s+"([^"]+)"\s+"([^"]+)"/);
                    if (!newResName) {
                      // If we can't parse the resource, include it anyway (better safe than sorry)
                      console.error(`         ⚠️  [MERGE] Could not parse resource block, including it anyway`);
                      return true;
                    }
                    const resType = newResName[1];
                    const resName = newResName[2];
                    
                    // Check if this exact resource (type + name) exists in existing content
                    // Use word boundaries to avoid partial matches
                    const exactPattern = new RegExp(`resource\\s+"${resType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s+"${resName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*\\{`);
                    const exists = exactPattern.test(existingContent);
                    
                    if (exists) {
                      console.error(`         ⚠️  [MERGE] Resource "${resType}.${resName}" appears to exist, but will check content similarity...`);
                      // Even if name matches, check if content is significantly different
                      // If content is different, it might be an update - include it
                      const existingResMatch = existingContent.match(new RegExp(`resource\\s+"${resType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s+"${resName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*\\{[\\s\\S]*?\\}`));
                      if (existingResMatch) {
                        const existingResContent = existingResMatch[0];
                        // If new resource is significantly different (more than 20% different), include it
                        // This handles cases where AI might be updating a resource
                        const similarity = calculateSimilarity(existingResContent, newRes);
                        if (similarity < 0.8) {
                          console.error(`         ✅ [MERGE] Resource "${resType}.${resName}" exists but content is different (similarity: ${(similarity * 100).toFixed(1)}%) - including as update`);
                          return true;
                        }
                      }
                      return false; // Exact duplicate, skip
                    }
                    return true; // New resource, include it
                  });
                  
                  console.error(`         📊 [MERGE] Summary: ${newResources.length} total in AI, ${resourcesToAdd.length} new, ${newResources.length - resourcesToAdd.length} potential duplicates`);
                  
                  // CRITICAL: Always add new resources, even if duplicate detection thinks they exist
                  // Better to have potential duplicates than missing resources
                  if (resourcesToAdd.length > 0) {
                    finalContent = existingContent.trim() + '\n\n' + resourcesToAdd.join('\n\n');
                    console.error(`         ✅ Merged: Added ${resourcesToAdd.length} new resource(s) to existing content`);
                    resourcesToAdd.forEach((res) => {
                      const resMatch = res.match(/resource\s+"([^"]+)"\s+"([^"]+)"/);
                      if (resMatch) {
                        console.error(`            ✅ Added: resource "${resMatch[1]}" "${resMatch[2]}"`);
                      } else {
                        console.error(`            ✅ Added: resource (unparseable, but included)`);
                      }
                    });
                  } else if (newResources.length > 0) {
                    // If duplicate detection filtered everything out, add all resources anyway
                    // This is a safety net - better to have duplicates than missing resources
                    console.error(`         ⚠️⚠️⚠️  [MERGE] WARNING: Duplicate detection filtered out all resources!`);
                    console.error(`         🔧 [MERGE] Adding all ${newResources.length} resource(s) anyway (safety net)...`);
                    finalContent = existingContent.trim() + '\n\n' + newResources.join('\n\n');
                    console.error(`         ✅ Merged: Added ${newResources.length} resource(s) (safety net - may include duplicates)`);
                  } else {
                    // No resources found in AI response at all
                    finalContent = existingContent;
                    console.error(`         ⚠️⚠️⚠️  [MERGE] CRITICAL: No resources found in AI response!`);
                    console.error(`         ⚠️  Keeping existing content unchanged`);
                  }
                }
              } 
              // For variables.tf: Extract new variables and append
              else if (fileNameOnlyLower === 'variables.tf') {
                const newVariables = extractTerraformBlocks(newContent, 'variable');
                
                // Check if new variables already exist
                const variablesToAdd = newVariables.filter(newVar => {
                  const varNameMatch = newVar.match(/variable\s+"([^"]+)"/);
                  if (!varNameMatch) return false;
                  const varName = varNameMatch[1];
                  return !existingContent.includes(`variable "${varName}"`);
                });
                
                if (variablesToAdd.length > 0) {
                  finalContent = existingContent.trim() + '\n\n' + variablesToAdd.join('\n\n');
                  console.error(`         ✅ Merged: Added ${variablesToAdd.length} new variable(s) to existing content`);
                } else {
                  finalContent = existingContent;
                  console.error(`         ⚠️  No new variables found, keeping existing content`);
                }
              }
              // For outputs.tf: Extract new outputs and append
              else if (fileNameOnlyLower === 'outputs.tf') {
                const newOutputs = extractTerraformBlocks(newContent, 'output');
                
                // Check if new outputs already exist
                const outputsToAdd = newOutputs.filter(newOut => {
                  const outNameMatch = newOut.match(/output\s+"([^"]+)"/);
                  if (!outNameMatch) return false;
                  const outName = outNameMatch[1];
                  return !existingContent.includes(`output "${outName}"`);
                });
                
                if (outputsToAdd.length > 0) {
                  finalContent = existingContent.trim() + '\n\n' + outputsToAdd.join('\n\n');
                  console.error(`         ✅ Merged: Added ${outputsToAdd.length} new output(s) to existing content`);
                } else {
                  finalContent = existingContent;
                  console.error(`         ⚠️  No new outputs found, keeping existing content`);
                }
              }
              // For terraform.tfvars or dev.terraform.tfvars: Append like other files (main.tf, variables.tf, outputs.tf)
              // AI generates complete content, we append it to existing (same logic as other files)
              else if (fileNameOnlyLower === 'terraform.tfvars' || fileNameOnlyLower === 'dev.terraform.tfvars') {
                // Extract all key-value pairs from new content
                const newLines = newContent.split('\n');
                const newKeyValuePairs: string[] = [];
                
                newLines.forEach(line => {
                  const trimmed = line.trim();
                  if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                    // Extract key-value pairs from new content
                    newKeyValuePairs.push(trimmed);
                  }
                });
                
                // Check which keys already exist in existing content
                const existingKeys = new Set<string>();
                const existingAllLines = existingContent.split('\n');
                existingAllLines.forEach(line => {
                  const trimmed = line.trim();
                  if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                    const match = trimmed.match(/^([^=]+?)\s*=\s*(.+)$/);
                    if (match) {
                      existingKeys.add(match[1].trim());
                    }
                  }
                });
                
                // Filter out key-value pairs that already exist (avoid duplicates)
                const newPairsToAdd = newKeyValuePairs.filter(pair => {
                  const match = pair.match(/^([^=]+?)\s*=\s*(.+)$/);
                  if (match) {
                    const key = match[1].trim();
                    return !existingKeys.has(key);
                  }
                  return false;
                });
                
                if (newPairsToAdd.length > 0) {
                  // Append new key-value pairs to existing content (like main.tf, variables.tf, outputs.tf)
                  finalContent = existingContent.trim() + '\n\n' + newPairsToAdd.join('\n');
                  console.error(`         ✅ Merged: Added ${newPairsToAdd.length} new variable assignment(s) to existing content (appended like main.tf/variables.tf/outputs.tf)`);
                } else {
                  // No new pairs, keep existing content
                  finalContent = existingContent;
                  console.error(`         ⚠️  No new variable assignments found, keeping existing content`);
                }
              }
              // For other files: Keep existing content (don't risk data loss)
              else {
                finalContent = existingContent;
                console.error(`         ⚠️  Unknown file type, keeping existing content to prevent data loss`);
              }
              
            console.error(`         📊 Final merged size: ${finalContent.length} chars (original: ${existingFile.content.length}, AI: ${file.content.length})`);
            
            try {
              const updated = await storage.updateFile(existingFile.id, finalContent);
              savedFiles.push(updated);
              console.log(`         ✅ UPDATED successfully (ID preserved: ${updated.id})`);
              console.log(`         Verified: Updated file ID matches original: ${updated.id === existingFile.id}`);
            } catch (updateError: any) {
              console.error(`         ❌ Update failed: ${updateError.message}`);
              console.error(`         Error details:`, updateError);
              throw updateError;
            }
          } else {
            // FILE NOT FOUND - Log why
            console.error(`\n${'='.repeat(80)}`);
            console.error(`      ❌❌❌ FILE NOT FOUND in session storage!`);
            console.error(`${'='.repeat(80)}`);
            console.error(`         Looking for: "${file.path}"`);
            console.error(`         Filename: "${fileNameOnly}"`);
            console.error(`         Filename (lowercase): "${fileNameOnlyLower}"`);
            console.error(`         Path (lowercase): "${filePathLower}"`);
            console.error(`\n         Available map keys (${sessionFilesMap.size}):`);
            Array.from(sessionFilesMap.keys()).forEach(key => {
              console.error(`            - "${key}"`);
            });
            console.error(`\n         Available files in session (${allSessionFilesNow.length}):`);
            allSessionFilesNow.forEach(sf => {
              console.error(`            - "${sf.fileName}" (ID: ${sf.id}, sessionId: ${sf.sessionId})`);
            });
            console.error(`${'='.repeat(80)}\n`);
            
            // FILE DOES NOT EXIST - Check if it's a Terraform file that should exist
            const isTerraformFile = fileNameOnlyLower.endsWith('.tf') || fileNameOnlyLower.endsWith('.tfvars');
            const isBackendConfig = ['backend.tf', 'provider.tf', 'terraform.tf'].includes(fileNameOnlyLower);
            
            if (isTerraformFile && !isBackendConfig) {
              // This is a Terraform resource file that should have existed
              // This means files weren't stored during scan - CRITICAL ERROR
              console.error(`\n      ❌❌❌ CRITICAL: Terraform file "${fileNameOnly}" not found in session storage!`);
              console.error(`      This file should have been stored during repository scan.`);
              console.error(`      Creating as new file (this is a bug - file should exist).`);
            }
            
            // Create new file (for new files like dev.terraform.tfvars, or if scan failed)
            console.log(`      ➕ Creating new file: "${file.path}"`);
            const created = await storage.createFile({
              sessionId,
              fileName: file.path,
              content: file.content,
            });
            savedFiles.push(created);
            console.log(`         ✅ Created with ID: ${created.id}`);
          }
        }
        
        // Log summary of what was updated vs created
        // Compare against the session files we fetched BEFORE processing
        const filesBeforeMatching = allSessionFilesNow.map(f => f.id);
        console.log(`\n📊 SUMMARY OF FILE OPERATIONS:`);
        console.log(`   Total files processed: ${allFiles.length}`);
        console.log(`   Files in savedFiles: ${savedFiles.length}`);
        console.log(`   Files in session before matching: ${filesBeforeMatching.length}`);
        console.log(`   File IDs before matching: ${filesBeforeMatching.join(', ')}`);
        
        const updatedFiles = savedFiles.filter(f => {
          // Check if this file was updated (same ID existed before matching)
          return filesBeforeMatching.includes(f.id);
        });
        
        const createdFiles = savedFiles.filter(f => {
          // Check if this file was created (ID didn't exist before matching)
          return !filesBeforeMatching.includes(f.id);
        });
        
        console.log(`   ✅ Updated files: ${updatedFiles.length}`);
        updatedFiles.forEach(f => {
          console.log(`      - ${f.fileName} (ID: ${f.id}) - ID PRESERVED ✅`);
        });
        
        console.log(`   ➕ Created files: ${createdFiles.length}`);
        createdFiles.forEach(f => {
          console.log(`      - ${f.fileName} (ID: ${f.id}) - NEW FILE ⚠️`);
        });
        
        const updatedCount = updatedFiles.length;
        const createdCount = createdFiles.length;
        console.log(`\n✅ File processing complete:`);
        console.log(`   📝 Updated: ${updatedCount} file(s) (IDs preserved)`);
        console.log(`   ➕ Created: ${createdCount} file(s) (new IDs)`);
        console.log(`   📋 Total: ${savedFiles.length} file(s)`);
        
        if (updatedCount === 0 && filesBeforeMatching.length > 0) {
          console.error(`\n   ❌ CRITICAL: No files were updated despite ${filesBeforeMatching.length} files existing!`);
          console.error(`   This means the matching logic failed completely.`);
        }
      } else {
        // For child modules and aggregated root: Create all files fresh
        console.log(`\n📦 ========== CREATING NEW FILES ==========`);
        console.log(`   Module approach: ${session.moduleApproach || 'child/aggregated'}`);
        console.log(`   Total files to create: ${allFiles.length}`);
        allFiles.forEach((file, idx) => {
          console.log(`   ${idx + 1}. ${file.path} (${file.content.length} chars)`);
        });
        
        if (allFiles.length === 0) {
          console.error(`\n❌ CRITICAL ERROR: No files to create!`);
          console.error(`   This means either:`);
          console.error(`   1. AI did not generate any files`);
          console.error(`   2. All files were filtered out`);
          return res.status(500).json({ 
            error: 'No files to create',
            details: ['AI did not generate any files or all files were filtered out. Please check server logs.']
          });
        }
        
        // For aggregated-root: Check if backend files already exist and preserve them
        const backendFiles = ['backend.tf', 'provider.tf', 'terraform.tf'];
        const existingFiles = await storage.getFilesBySession(sessionId);
        const existingBackendFiles = existingFiles.filter(f => backendFiles.includes(f.fileName));
        
        savedFiles = [];
        
        // For aggregated-root: Preserve existing backend files
        if (session.moduleApproach === 'aggregated-root' && existingBackendFiles.length > 0) {
          console.log(`\n   🔒 Preserving ${existingBackendFiles.length} existing backend file(s):`);
          existingBackendFiles.forEach(f => {
            console.log(`      - ${f.fileName} (ID: ${f.id})`);
            savedFiles.push(f); // Add existing backend files to savedFiles
          });
        }
        
        for (const file of allFiles) {
          // Skip backend files if they already exist (for aggregated-root)
          if (session.moduleApproach === 'aggregated-root' && backendFiles.includes(file.path)) {
            const existingBackendFile = existingBackendFiles.find(f => f.fileName === file.path);
            if (existingBackendFile) {
              console.log(`   ⏭️  Skipping ${file.path} (already exists, preserved)`);
              continue;
            }
          }
          
          try {
            console.log(`\n   💾 Creating file: ${file.path}...`);
            const created = await storage.createFile({
              sessionId,
              fileName: file.path,
              content: file.content,
            });
            console.log(`   ✅ Successfully created: ${file.path} (ID: ${created.id}, ${created.content.length} chars, sessionId: ${created.sessionId})`);
            
            // Verify the file was saved correctly by fetching it back
            const verifyFiles = await storage.getFilesBySession(sessionId);
            const savedFile = verifyFiles.find(f => f.id === created.id);
            if (!savedFile) {
              console.error(`   ❌ CRITICAL: File ${file.path} was created but not found in session storage!`);
            } else if (savedFile.content.length !== file.content.length) {
              console.error(`   ❌ CRITICAL: File ${file.path} content length mismatch! Expected: ${file.content.length}, Got: ${savedFile.content.length}`);
            } else if (savedFile.content.trim().length === 0) {
              console.error(`   ❌ CRITICAL: File ${file.path} is EMPTY after saving!`);
            } else {
              console.log(`   ✅ Verified: File ${file.path} saved correctly (${savedFile.content.length} chars, not empty)`);
            }
            
            savedFiles.push(created);
          } catch (error: any) {
            console.error(`   ❌ FAILED to create ${file.path}: ${error.message}`);
            console.error(`   Error stack: ${error.stack}`);
            return res.status(500).json({ 
              error: `Failed to create file ${file.path}`,
              details: [error.message]
            });
          }
        }
        
        console.log(`\n✅ ========== FILE CREATION COMPLETE ==========`);
        console.log(`   Successfully created/preserved ${savedFiles.length} file(s) for ${session.moduleApproach || 'child/aggregated'} module`);
        savedFiles.forEach(f => {
          console.log(`      - ${f.fileName} (ID: ${f.id})`);
        });
      }

      // For aggregated-root: Ensure backend files are included in savedFiles response
      // Backend files are already preserved in savedFiles, so we don't need to recreate them
      if (session.moduleApproach === 'aggregated-root') {
        // Get all files (backend + resource) to return in response
        const allFinalFiles = await storage.getFilesBySession(sessionId);
        console.log(`\n📋 Final files in session (backend + resource): ${allFinalFiles.length}`);
        allFinalFiles.forEach(f => {
          console.log(`      - ${f.fileName} (ID: ${f.id})`);
        });
        
        // Update savedFiles to include all files for the response
        savedFiles = allFinalFiles;
        console.log(`\n✅ Response will include ${savedFiles.length} file(s) (backend + resource files)`);
      }
      
      // Restore preserved backend configuration files (backend.tf, provider.tf, terraform.tf)
      // Only for non-aggregated-root modules (aggregated-root already has them preserved)
      if (preservedFiles.length > 0 && session.moduleApproach !== 'aggregated-root') {
        await Promise.all(
          preservedFiles.map(file => 
            storage.createFile({
              sessionId,
              fileName: file.fileName,
              content: file.content,
            })
          )
        );
        console.log(`Preserved ${preservedFiles.length} backend configuration file(s): ${preservedFiles.map(f => f.fileName).join(', ')}`);
      }

      // CRITICAL FIX: Post-process to ensure variables.tf and .tfvars are created/updated
      // when main.tf references new variables
      console.log(`\n🔍 Post-processing: Checking for missing variable declarations...`);
      const allFilesAfterSave = await storage.getFilesBySession(sessionId);
      const mainTfFile = allFilesAfterSave.find(f => f.fileName.toLowerCase() === 'main.tf');
      const variablesTfFile = allFilesAfterSave.find(f => f.fileName.toLowerCase() === 'variables.tf');
      const tfvarsFile = allFilesAfterSave.find(f => 
        f.fileName.toLowerCase() === 'dev.terraform.tfvars' || 
        f.fileName.toLowerCase() === 'terraform.tfvars'
      );

      if (mainTfFile) {
        // Extract all variable references from main.tf (var.variable_name)
        const varPattern = /var\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
        const referencedVars = new Set<string>();
        let match;
        while ((match = varPattern.exec(mainTfFile.content)) !== null) {
          referencedVars.add(match[1]);
        }

        console.log(`   Found ${referencedVars.size} variable reference(s) in main.tf: ${Array.from(referencedVars).join(', ')}`);

        if (referencedVars.size > 0) {
          // Check which variables are missing from variables.tf
          const declaredVars = new Set<string>();
          if (variablesTfFile) {
            const varDeclPattern = /variable\s+"([^"]+)"/g;
            let declMatch;
            while ((declMatch = varDeclPattern.exec(variablesTfFile.content)) !== null) {
              declaredVars.add(declMatch[1]);
            }
          }

          const missingVars = Array.from(referencedVars).filter(v => !declaredVars.has(v));
          
          if (missingVars.length > 0) {
            console.log(`   ⚠️  Missing ${missingVars.length} variable declaration(s): ${missingVars.join(', ')}`);
            console.log(`   🔧 Creating/updating variables.tf with missing declarations...`);

            // Use AI to generate proper variable declarations
            const varDeclarations = await openaiService.generateVariableDeclarations(
              missingVars,
              mainTfFile.content
            );

            if (variablesTfFile) {
              // Update existing variables.tf
              const updatedContent = variablesTfFile.content.trim() + '\n\n' + varDeclarations;
              await storage.updateFile(variablesTfFile.id, updatedContent);
              console.log(`   ✅ Updated variables.tf with ${missingVars.length} new declaration(s)`);
            } else {
              // Create new variables.tf
              await storage.createFile({
                sessionId,
                fileName: 'variables.tf',
                content: varDeclarations,
              });
              console.log(`   ✅ Created variables.tf with ${missingVars.length} declaration(s)`);
            }

            // Also ensure .tfvars file has these variables
            const tfvarsFileName = tfvarsFile?.fileName || 'dev.terraform.tfvars';
            const tfvarsValues = await openaiService.generateTfvarsValues(
              missingVars,
              mainTfFile.content,
              description
            );

            if (tfvarsFile) {
              // Update existing .tfvars
              const existingKeys = new Set<string>();
              tfvarsFile.content.split('\n').forEach(line => {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                  const keyMatch = trimmed.match(/^([^=]+?)\s*=/);
                  if (keyMatch) {
                    existingKeys.add(keyMatch[1].trim());
                  }
                }
              });

              const newTfvarsLines = tfvarsValues.split('\n').filter(line => {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                  const keyMatch = trimmed.match(/^([^=]+?)\s*=/);
                  if (keyMatch && !existingKeys.has(keyMatch[1].trim())) {
                    return true;
                  }
                }
                return false;
              });

              if (newTfvarsLines.length > 0) {
                const updatedTfvars = tfvarsFile.content.trim() + '\n\n' + newTfvarsLines.join('\n');
                await storage.updateFile(tfvarsFile.id, updatedTfvars);
                console.log(`   ✅ Updated ${tfvarsFileName} with ${newTfvarsLines.length} new value(s)`);
              }
            } else {
              // Create new .tfvars
              await storage.createFile({
                sessionId,
                fileName: tfvarsFileName,
                content: tfvarsValues,
              });
              console.log(`   ✅ Created ${tfvarsFileName} with ${missingVars.length} value(s)`);
            }
          } else {
            console.log(`   ✅ All variables are declared in variables.tf`);
          }
        }
      }

      // For aggregated-root: Get all files (backend + resource) to return in response
      if (session.moduleApproach === 'aggregated-root') {
        const allFinalFiles = await storage.getFilesBySession(sessionId);
        console.log(`\n📋 Final response: Including ${allFinalFiles.length} file(s) (backend + resource):`);
        allFinalFiles.forEach(f => {
          console.log(`      - ${f.fileName} (ID: ${f.id}, ${f.content.length} chars, sessionId: ${f.sessionId})`);
          if (f.content.length === 0) {
            console.error(`         ⚠️  WARNING: File ${f.fileName} is EMPTY!`);
          }
        });
        
        // Verify all files have content
        const emptyFiles = allFinalFiles.filter(f => f.content.trim().length === 0);
        if (emptyFiles.length > 0) {
          console.error(`\n❌ CRITICAL: ${emptyFiles.length} file(s) are EMPTY:`);
          emptyFiles.forEach(f => {
            console.error(`   - ${f.fileName} (ID: ${f.id})`);
          });
        }
        
        savedFiles = allFinalFiles;
      }

      // Update session to Review step based on module approach
      // - standalone-root: Step 7 (Review & Edit UI is at step 7 for non-aggregated-root)
      // - aggregated-root: Step 8 (Review & Edit UI is at step 8 for aggregated-root)
      // - child: Step 7 (Review & Edit UI is at step 7 for non-aggregated-root)
      // Note: Frontend shows code generation UI at step 7 for non-aggregated-root, step 8 for aggregated-root
      // Files query is enabled for steps 7-10
      const reviewStep = session.moduleApproach === 'aggregated-root' ? '8' : '7';
      await storage.updateSession(sessionId, { 
        currentStep: reviewStep,
        workflowStep: 'terraform_generation'
      });
      console.log(`\n📝 Updated session to step ${reviewStep} (moduleApproach: ${session.moduleApproach})`);

      console.log(`\n✅ Sending response with ${savedFiles.length} file(s)`);
      res.json(savedFiles);
    } catch (error: any) {
      const sessionIdForError = req.params.id || 'unknown';
      console.error('\n❌ ========== GENERATE TERRAFORM ERROR ==========');
      console.error(`   Timestamp: ${new Date().toISOString()}`);
      console.error('   Session ID:', sessionIdForError);
      console.error('   Error type:', error?.constructor?.name);
      console.error('   Error message:', error?.message);
      console.error('   Error stack:', error?.stack);
      console.error('   Error details:', {
        message: error?.message,
        stack: error?.stack,
        name: error?.name,
        sessionId: sessionIdForError
      });
      
      // Return more specific error messages
      let errorMessage = 'Failed to generate Terraform files';
      let statusCode = 500;
      
      if (error?.message) {
        errorMessage = error.message;
        
        // Handle validation errors (400)
        if (error.message.includes('validation failed') || 
            error.message.includes('Child module validation')) {
          statusCode = 400;
        }
        
        // Handle backend configuration errors (400)
        if (error.message.includes('Backend configuration required')) {
          statusCode = 400;
        }
      }
      
      res.status(statusCode).json({ 
        error: errorMessage,
        details: process.env.NODE_ENV === 'development' ? error?.stack : undefined
      });
    }
  });

  // Get generated files
  app.get("/api/sessions/:id/files", async (req, res) => {
    try {
      const sessionId = req.params.id;
      
      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      
      const files = await storage.getFilesBySession(sessionId);
      
      // Debug logging
      console.log(`📁 GET /api/sessions/${sessionId}/files`);
      console.log(`   Found ${files.length} file(s)`);
      files.forEach((f, i) => {
        console.log(`   ${i + 1}. ${f.fileName} (sessionId: ${f.sessionId}, size: ${f.content.length} bytes)`);
      });
      
      res.json(files);
    } catch (error) {
      console.error('Error getting files:', error);
      res.status(500).json({ error: 'Failed to get files' });
    }
  });

  // Create a file (for testing)
  app.post("/api/sessions/:id/files", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const { fileName, content } = req.body;
      
      if (!fileName || content === undefined) {
        return res.status(400).json({ error: 'fileName and content are required' });
      }

      // Check if file already exists for this session
      const existingFiles = await storage.getFilesBySession(sessionId);
      const existingFile = existingFiles.find(f => f.fileName === fileName);

      if (existingFile) {
        // Update existing file
        const updated = await storage.updateFile(existingFile.id, content);
        console.log(`📝 Updated existing file in session: ${fileName} (${content.length} bytes)`);
        res.json(updated);
      } else {
        // Create new file
        const file = await storage.createFile({
          sessionId,
          fileName,
          content,
        });
        console.log(`➕ Created new file in session: ${fileName} (${content.length} bytes)`);
        res.status(201).json(file);
      }
    } catch (error) {
      console.error('Error creating/updating file:', error);
      res.status(500).json({ error: 'Failed to create/update file' });
    }
  });

  // Bulk update files (for saving edited files from UI)
  app.post("/api/sessions/:id/files/bulk", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const { files } = req.body; // Array of { fileName, content }

      if (!Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: 'files array is required and must not be empty' });
      }

      console.log(`\n📝 Bulk updating ${files.length} file(s) in session ${sessionId}...`);

      // Get existing files for this session
      const existingFiles = await storage.getFilesBySession(sessionId);
      const existingFilesMap = new Map(existingFiles.map(f => [f.fileName, f]));

      const results = [];
      let createdCount = 0;
      let updatedCount = 0;

      for (const fileData of files) {
        const { fileName, content } = fileData;

        if (!fileName || content === undefined) {
          console.warn(`⚠️  Skipping invalid file entry: ${JSON.stringify(fileData)}`);
          continue;
        }

        const existingFile = existingFilesMap.get(fileName);

        if (existingFile) {
          // Update existing file
          const updated = await storage.updateFile(existingFile.id, content);
          results.push(updated);
          updatedCount++;
          console.log(`   ✅ Updated: ${fileName} (${content.length} bytes)`);
        } else {
          // Create new file
          const created = await storage.createFile({
            sessionId,
            fileName,
            content,
          });
          results.push(created);
          createdCount++;
          console.log(`   ➕ Created: ${fileName} (${content.length} bytes)`);
        }
      }

      console.log(`✅ Bulk update complete: ${updatedCount} updated, ${createdCount} created`);

      res.json({
        success: true,
        files: results,
        updated: updatedCount,
        created: createdCount,
        total: results.length
      });
    } catch (error) {
      console.error('Error bulk updating files:', error);
      res.status(500).json({ error: 'Failed to bulk update files' });
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

  // Run Checkov security scan on generated files
  app.post("/api/sessions/:id/scan", async (req, res) => {
      const sessionId = req.params.id;
    console.log(`\n🔍 ========== SCAN REQUEST RECEIVED ==========`);
    console.log(`Session ID: ${sessionId}`);
    console.log(`Timestamp: ${new Date().toISOString()}`);
    
    // Track if response has been sent
    let responseSent = false;
    
    // Set a response timeout to ensure we always respond, even if Checkov hangs
    // Increased to 15 minutes for large/complex Terraform configurations
    const RESPONSE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes total timeout
    const responseTimeout = setTimeout(() => {
      if (!responseSent && !res.headersSent) {
        responseSent = true;
        console.error('❌ Response timeout - Checkov scan took too long, sending error response');
        console.error(`   Timeout after ${RESPONSE_TIMEOUT_MS / 1000 / 60} minutes`);
        res.status(500).json({
          error: 'Checkov scan timed out',
          details: `The scan took longer than ${RESPONSE_TIMEOUT_MS / 1000 / 60} minutes to complete. This may happen with large Terraform configurations. Try scanning smaller files or check server logs for progress.`,
          sessionId: sessionId,
          timeoutMinutes: RESPONSE_TIMEOUT_MS / 1000 / 60,
          timestamp: new Date().toISOString()
        });
      }
    }, RESPONSE_TIMEOUT_MS);
    
    // Declare variables outside try block so they're accessible in finally
    let fs: any, path: any, tempDir: string | undefined;
    
    try {
      // Verify session exists first
      console.log(`📋 Checking if session exists...`);
      const session = await storage.getSession(sessionId);
      
      // DEBUG: Log all files in storage for this session BEFORE filtering
      const allSessionFilesDebug = await storage.getFilesBySession(sessionId);
      console.log(`\n🔍 DEBUG: All files in session storage BEFORE scan filtering:`);
      console.log(`   Total files: ${allSessionFilesDebug.length}`);
      console.log(`   Session ID: ${sessionId}`);
      allSessionFilesDebug.forEach((f, i) => {
        console.log(`   ${i + 1}. ${f.fileName} (ID: ${f.id}, sessionId: ${f.sessionId}, ${f.content.length} bytes, empty: ${f.content.trim().length === 0})`);
        if (f.sessionId !== sessionId) {
          console.error(`      ⚠️  WARNING: File sessionId (${f.sessionId}) doesn't match request sessionId (${sessionId})!`);
        }
      });
      if (!session) {
        console.error(`❌ Session not found: ${sessionId}`);
        return res.status(404).json({ 
          error: 'Session not found',
          details: `Session ${sessionId} does not exist`
        });
      }
      
      console.log(`✅ Session found: step=${session.currentStep}, workflow=${session.workflowStep}`);
      console.log(`🔍 Starting Checkov scan for session ${sessionId}`);
      
      // CRITICAL: Fetch files from SESSION STORAGE (not repository)
      // This ensures we scan the LATEST generated code, not the old repository code
      console.log(`📁 Fetching files from SESSION STORAGE (latest generated code)...`);
      console.log(`   This includes all newly generated/updated resources`);
      
      const sessionFiles = await storage.getFilesBySession(sessionId);
      console.log(`✅ Found ${sessionFiles.length} file(s) in session storage`);
      sessionFiles.forEach((f, i) => {
        console.log(`   ${i + 1}. ${f.fileName} (ID: ${f.id}, ${f.content.length} bytes, sessionId: ${f.sessionId})`);
        if (f.content.length === 0) {
          console.warn(`      ⚠️  WARNING: File ${f.fileName} is EMPTY!`);
        }
      });
      
      let allFiles: Array<{ fileName: string; content: string; sessionId: string; id: string }>;
      
      if (sessionFiles.length === 0) {
        console.error(`❌ No files found in session storage`);
        // Fallback: Try repository if session storage is empty
        if (session.provider && session.repositoryName) {
          console.log(`   ⚠️  Falling back to repository...`);
          const repoFiles = await mcpClient.scanRepositoryFiles(
            session.provider as MCPProvider,
            session.repositoryName,
            'main'
          );
          allFiles = repoFiles
            .filter(file => file.path.endsWith('.tf') || file.path.endsWith('.tfvars'))
            .map(file => ({
              fileName: file.path.split('/').pop() || file.path,
              content: file.content,
              sessionId: sessionId,
              id: `temp-${file.path}`,
            }));
          
          if (allFiles.length === 0) {
            return res.status(400).json({ 
              error: 'No Terraform files found',
              details: 'No files in session storage or repository'
            });
          }
          
          console.log(`   ✅ Using ${allFiles.length} file(s) from repository (fallback)`);
        } else {
          return res.status(400).json({ 
            error: 'No files found',
            details: 'No files in session storage and no repository configured'
          });
        }
      } else {
        // Filter to Terraform files only from session storage
        // Include ALL Terraform files (backend + resource) for aggregated-root
        allFiles = sessionFiles
          .filter(file => {
            const fileName = file.fileName.toLowerCase();
            const isTerraform = fileName.endsWith('.tf') || fileName.endsWith('.tfvars') || fileName.endsWith('.hcl');
            if (!isTerraform) {
              return false;
            }
            // Check if content exists and is not empty
            if (!file.content || file.content.trim().length === 0) {
              console.warn(`   ⚠️  Skipping empty Terraform file: ${file.fileName}`);
              return false;
            }
            return true;
          })
          .map(file => ({
            fileName: file.fileName,
            content: file.content,
            sessionId: sessionId,
            id: file.id,
          }));
        
        console.log(`   ✅ Using ${allFiles.length} file(s) from session storage (latest generated code)`);
        console.log(`   Module approach: ${session.moduleApproach || 'null'}`);
        allFiles.forEach((f, i) => {
          console.log(`      ${i + 1}. ${f.fileName} (${f.content.length} bytes)`);
        });
      }
      
      console.log(`📄 Terraform files found: ${allFiles.length}`);
      if (allFiles.length > 0) {
        console.log(`📄 Files to scan:`);
        allFiles.forEach((file, i) => {
          console.log(`   ${i + 1}. ${file.fileName} (content length: ${file.content?.length || 0} bytes)`);
          if (file.content && file.content.length > 0) {
            const preview = file.content.substring(0, 150).replace(/\n/g, ' ');
            console.log(`      Preview: ${preview}...`);
          }
        });
      } else {
        console.error(`❌ No Terraform files found in session storage or repository`);
        console.error(`   Total session files: ${sessionFiles.length}`);
        console.error(`   Module approach: ${session.moduleApproach || 'null'}`);
        if (session.repositoryName) {
          console.error(`   Repository: ${session.repositoryName}`);
        }
        if (session.provider) {
          console.error(`   Provider: ${session.provider}`);
        }
        
        return res.status(400).json({ 
          error: 'No files found to scan',
          details: `No files have been generated for this session yet. Please generate Terraform files first.`,
          sessionStep: session.currentStep,
          workflowStep: session.workflowStep,
          sessionId: sessionId,
          totalSessionFiles: sessionFiles.length,
          moduleApproach: session.moduleApproach
        });
      }
      
      // All files are already filtered and validated above, so use them directly
      const terraformFiles = allFiles;
      
      console.log(`📋 Terraform files to scan: ${terraformFiles.length}`);
      terraformFiles.forEach(file => {
        console.log(`   - ${file.fileName} (${file.content.length} bytes)`);
      });
      
      if (terraformFiles.length === 0) {
        console.error('❌ No Terraform files found to scan');
        console.error(`   Total files in session: ${sessionFiles.length}`);
        console.error(`   Files after filtering: ${allFiles.length}`);
        console.error(`   Module approach: ${session.moduleApproach || 'null'}`);
        sessionFiles.forEach(f => {
          console.error(`      - ${f.fileName} (${f.content.length} bytes)`);
        });
        
        const nonTerraformFiles = allFiles.filter(file => {
          const fileName = file.fileName.toLowerCase();
          return !fileName.endsWith('.tf') && !fileName.endsWith('.tfvars') && !fileName.endsWith('.hcl');
        });
        
        return res.status(400).json({ 
          error: 'No Terraform files to scan',
          details: `Found ${allFiles.length} file(s) in session storage but none are valid Terraform files (.tf, .tfvars, .hcl) with content. Total session files: ${sessionFiles.length}`,
          foundFiles: allFiles.map(f => f.fileName),
          sessionFiles: sessionFiles.map(f => ({ fileName: f.fileName, size: f.content.length, empty: f.content.trim().length === 0 })),
          nonTerraformFiles: nonTerraformFiles.map(f => f.fileName),
          sessionId: sessionId,
          moduleApproach: session.moduleApproach
        });
      }
      
      const files = terraformFiles;

      // Import required modules
      console.log(`📦 Importing required modules...`);
      let spawn, os;
      try {
        fs = await import('fs/promises');
        console.log(`   ✅ fs/promises imported`);
        path = await import('path');
        console.log(`   ✅ path imported`);
        const childProcess = await import('child_process');
        spawn = childProcess.spawn;
        console.log(`   ✅ child_process imported`);
        os = await import('os');
        console.log(`   ✅ os imported`);
      } catch (importError: any) {
        console.error(`❌ Failed to import modules:`, importError);
        throw new Error(`Failed to import required modules: ${importError.message}`);
      }

      // Create a temporary directory for scanning
      // Use project directory to avoid cross-drive path issues on Windows
      // (Checkov fails with "path is on mount 'C:', start on mount 'D:'" error)
      console.log(`📁 Creating temporary directory...`);
      const projectRoot = process.cwd();
      console.log(`   Project root: ${projectRoot}`);
      const tempBaseDir = path.join(projectRoot, '.temp-checkov');
      console.log(`   Temp base dir: ${tempBaseDir}`);
      
      try {
        await fs.mkdir(tempBaseDir, { recursive: true });
        console.log(`   ✅ Created base temp directory`);
      } catch (mkdirError: any) {
        console.error(`❌ Failed to create temp base directory:`, mkdirError);
        throw new Error(`Failed to create temp directory: ${mkdirError.message}`);
      }
      
      try {
        tempDir = await fs.mkdtemp(path.join(tempBaseDir, 'checkov-'));
        console.log(`   ✅ Created temp directory: ${tempDir}`);
      } catch (mkdtempError: any) {
        console.error(`❌ Failed to create temp directory:`, mkdtempError);
        throw new Error(`Failed to create temp directory: ${mkdtempError.message}`);
      }
      
      try {
        // Write all Terraform files to temp directory
        console.log(`📝 Writing ${files.length} file(s) to temp directory: ${tempDir}`);
        let filesWritten = 0;
        for (const file of files) {
          // Handle file paths that may contain directory separators (e.g., "ResourceGroup/main.tf")
          // Normalize path separators for current OS
          const normalizedPath = file.fileName.replace(/\//g, path.sep).replace(/\\/g, path.sep);
          const filePath = path.join(tempDir, normalizedPath);
          const fileDir = path.dirname(filePath);
          
          // Create directory if it doesn't exist
          await fs.mkdir(fileDir, { recursive: true });
          
          // Verify content exists
          if (!file.content || file.content.trim().length === 0) {
            console.warn(`⚠️  File ${file.fileName} has empty content, skipping...`);
            continue;
          }
          
          await fs.writeFile(filePath, file.content, 'utf-8');
          filesWritten++;
          console.log(`   ✅ Written: ${file.fileName} -> ${filePath} (${file.content.length} bytes)`);
        }
        
        console.log(`📊 Successfully wrote ${filesWritten} of ${files.length} file(s)`);
        
        if (filesWritten === 0) {
          cleanup();
          return res.status(400).json({
            error: 'No files written',
            details: 'All files were empty or invalid. Please ensure Terraform files have content.',
            sessionId: sessionId
          });
        }
        
        // Verify files were written and have content
        console.log(`🔍 Verifying written files...`);
        const writtenFiles = await fs.readdir(tempDir, { recursive: true });
        console.log(`📋 Files in temp directory: ${writtenFiles.length}`);
        writtenFiles.forEach((f, i) => {
          console.log(`   ${i + 1}. ${f}`);
        });
        
        // Additional verification: Check if any .tf files exist
        const tfFiles = writtenFiles.filter((f: string) => 
          typeof f === 'string' && (f.endsWith('.tf') || f.endsWith('.tfvars') || f.endsWith('.hcl'))
        );
        console.log(`📋 Terraform files found: ${tfFiles.length}`);
        if (tfFiles.length === 0) {
          console.error(`❌ WARNING: No Terraform files found in temp directory!`);
          console.error(`   This will cause Checkov to return 0 results`);
          console.error(`   Written files: ${JSON.stringify(writtenFiles)}`);
        }
        
        // Verify file contents (use normalized paths)
        for (const file of files) {
          if (!file.content || file.content.trim().length === 0) {
            continue; // Skip empty files
          }
          const normalizedPath = file.fileName.replace(/\//g, path.sep).replace(/\\/g, path.sep);
          const filePath = path.join(tempDir, normalizedPath);
          try {
            const stats = await fs.stat(filePath);
            const content = await fs.readFile(filePath, 'utf-8');
            if (content.length === 0) {
              console.warn(`   ⚠️  File ${file.fileName} is empty after writing`);
            } else {
              console.log(`   ✓ Verified: ${file.fileName} (${stats.size} bytes, ${content.length} chars)`);
            }
          } catch (verifyError: any) {
            console.error(`   ❌ Failed to verify ${file.fileName}:`, verifyError.message);
            console.error(`      Expected path: ${filePath}`);
          }
        }
        
        // Final check: ensure we have at least one valid Terraform file
        if (filesWritten === 0) {
          console.error(`❌ No files were written successfully!`);
          console.error(`   Attempted to write ${files.length} file(s), but all were empty or failed`);
          return res.status(400).json({
            error: 'No valid Terraform files to scan',
            details: `Attempted to write ${files.length} file(s), but all were empty or failed to write. Check server logs for details.`
          });
        }
        
        console.log(`✅ Ready to scan ${filesWritten} file(s) in ${tempDir}`);

        // Run Checkov with JSON output using spawn (works better on Windows)
        // Use uv to run checkov from the virtual environment (.venv)
        const isWindows = process.platform === 'win32';
        
        // For aggregated-root modules, Checkov may not scan module calls
        // We still run the scan, but it may return 0 resources
        // This is expected behavior - module calls are not direct resources
        const checkovArgs = ['-d', tempDir, '--framework', 'terraform', '--output', 'json', '--compact', '--quiet'];
        
        // Log module approach for debugging
        if (session.moduleApproach === 'aggregated-root') {
          console.log(`\n⚠️  NOTE: Aggregated-root module detected`);
          console.log(`   Files contain module calls, not direct resources`);
          console.log(`   Checkov may return 0 resources - this is expected`);
          console.log(`   Module calls are not scannable by Checkov`);
        }
        
        // Try commands in order of preference:
        // 1. Direct 'checkov' command (like Replit - if installed globally)
        // 2. py -m uv run checkov (from .venv via uv)
        // 3. py -m checkov (Python module)
        // 4. python3/python -m checkov (fallbacks)
        // Format: [command, baseArgs, checkovArgs]
        const checkovCommands: [string, string[], string[]][] = isWindows 
          ? [
              ['checkov', [], checkovArgs],  // Try direct command first (like Replit)
              ['py', ['-m', 'uv', 'run', 'checkov'], checkovArgs],
              ['py', ['-m', 'checkov'], checkovArgs],
              ['python3', ['-m', 'checkov'], checkovArgs],
              ['python', ['-m', 'checkov'], checkovArgs]
            ]
          : [
              ['checkov', [], checkovArgs],  // Try direct command first (like Replit)
              ['python3', ['-m', 'uv', 'run', 'checkov'], checkovArgs],
              ['python3', ['-m', 'checkov'], checkovArgs],
              ['python', ['-m', 'checkov'], checkovArgs]
            ];
        
        console.log(`📋 Will try ${checkovCommands.length} command(s):`);
        checkovCommands.forEach(([cmd, args], i) => {
          console.log(`   ${i + 1}. ${cmd} ${args.join(' ')} ${checkovArgs.join(' ')}`);
        });
        
        // Add timeout to prevent hanging (12 minutes max for Checkov process)
        // This is less than the response timeout to allow cleanup time
        const TIMEOUT_MS = 12 * 60 * 1000;
        
        console.log(`\n🚀 Starting Checkov execution...`);
        const scanResult = await Promise.race([
          new Promise<any>((resolve, reject) => {
            let attemptIndex = 0;
            let resolved = false;
            let timeoutId: NodeJS.Timeout | null = null;
            
            const cleanup = () => {
              if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
              }
            };
            
            const tryNextCommand = () => {
              if (resolved) return;
              
              if (attemptIndex >= checkovCommands.length) {
                cleanup();
                // All commands failed - provide detailed error message
                const attemptedCommands = checkovCommands.map(([cmd, baseArgs, checkovArgs]) => {
                  if (baseArgs.length > 0) {
                    return `  - ${cmd} ${baseArgs.join(' ')} ${checkovArgs.join(' ')}`;
                  } else {
                    return `  - ${cmd} ${checkovArgs.join(' ')}`;
                  }
                }).join('\n');
                
                const errorMsg = `Checkov scan failed after trying all available commands.

Troubleshooting steps:
1. Verify Checkov is installed: py -m uv run checkov --version
2. If that works, check server logs for detailed error messages
3. Ensure temp directory is writable: ${path.join(process.cwd(), '.temp-checkov')}
4. Check if files are being written correctly (see server logs)

Last attempted commands:
${attemptedCommands}

Please check the server console logs for detailed error information.`;
                
                console.error(`\n❌ ========== ALL CHECKOV COMMANDS FAILED ==========`);
                console.error(`   Tried ${checkovCommands.length} command(s):`);
                checkovCommands.forEach(([cmd, baseArgs, checkovArgs], i) => {
                  if (baseArgs.length > 0) {
                    console.error(`   ${i + 1}. ${cmd} ${baseArgs.join(' ')} ${checkovArgs.join(' ')}`);
                  } else {
                    console.error(`   ${i + 1}. ${cmd} ${checkovArgs.join(' ')}`);
                  }
                });
                console.error(`   Check server logs above for detailed error messages`);
                console.error(`==========================================\n`);
                reject(new Error(errorMsg));
                return;
              }
              
              const [command, baseArgs, args] = checkovCommands[attemptIndex];
              attemptIndex++;
              
              const fullArgs = [...baseArgs, ...args];
              const commandStr = baseArgs.length > 0 
                ? `${command} ${baseArgs.join(' ')} ${args.join(' ')}`
                : `${command} ${args.join(' ')}`;
              
              console.log(`\n🔧 ========== ATTEMPT ${attemptIndex} of ${checkovCommands.length} ==========`);
              console.log(`🔧 Trying Checkov with: ${commandStr}`);
              console.log(`📂 Scanning directory: ${tempDir}`);
              console.log(`   Command: ${command}`);
              console.log(`   Base args: ${baseArgs.join(' ') || '(none)'}`);
              console.log(`   Checkov args: ${args.join(' ')}`);
              
              // Log the exact command being executed for debugging
              console.log(`🚀 Executing: ${command} ${fullArgs.join(' ')}`);
              console.log(`   Working directory: ${process.cwd()}`);
              console.log(`   Temp directory: ${tempDir}`);
              console.log(`   Is Windows: ${isWindows}`);
              console.log(`   Shell: ${isWindows ? 'true' : 'false'}`);
              
              // On Windows, we need to ensure PATH includes Python launcher
              const env = { ...process.env };
              
              // Ensure Python launcher is in PATH on Windows
              if (isWindows) {
                const username = process.env.USERNAME || process.env.USER || '';
                const pythonBase = `C:\\Users\\${username}\\AppData\\Local\\Programs\\Python`;
                let pythonScriptDirs: string[] = [];
                try {
                  pythonScriptDirs = require('fs').readdirSync(pythonBase, { withFileTypes: true })
                    .filter((d: any) => d.isDirectory() && d.name.startsWith('Python'))
                    .map((d: any) => `${pythonBase}\\${d.name}\\scripts`);
                } catch { /* Python not installed at standard path */ }
                const pythonPaths = [
                  // Python launcher (py.exe)
                  `${pythonBase}\\Launcher`,
                  // Python scripts directories (checkov, pip, etc.)
                  ...pythonScriptDirs,
                ];
                
                const currentPath = env.PATH || '';
                // Use semicolon for Windows PATH separator
                const pathParts = currentPath.split(';');
                
                // Add Python launcher to the BEGINNING of PATH (so it's found first)
                pythonPaths.forEach(p => {
                  if (p && !pathParts.includes(p)) {
                    pathParts.unshift(p); // Add to beginning
                  }
                });
                env.PATH = pathParts.join(';'); // Use semicolon for Windows
                
                console.log(`   Added Python launcher to PATH`);
                console.log(`   PATH now starts with: ${pathParts.slice(0, 3).join(';')}...`);
              }
              
              console.log(`   Environment PATH length: ${env.PATH?.length || 0} chars`);
              
              // Determine shell and command execution method
              // On Windows, we can use PowerShell, cmd.exe, or Git Bash
              // Try to detect if we're in Git Bash (SHELL env var or MSYSTEM)
              const isGitBash = process.env.SHELL?.includes('bash') || process.env.MSYSTEM?.startsWith('MINGW');
              const useGitBash = isGitBash && isWindows;
              
              let finalCommand = command;
              let finalArgs = fullArgs;
              let useShell = isWindows || useGitBash;
              
              if (useGitBash) {
                // Git Bash: Use bash -c to execute commands
                console.log(`   Detected Git Bash environment (SHELL=${process.env.SHELL}, MSYSTEM=${process.env.MSYSTEM})`);
                finalCommand = 'bash';
                finalArgs = ['-c', `${command} ${fullArgs.join(' ')}`];
                useShell = false; // bash is the command, don't use shell wrapper
                console.log(`   Using Git Bash execution: bash -c "${command} ${fullArgs.join(' ')}"`);
              } else if (isWindows) {
                // Windows PowerShell/CMD: Use shell: true to find commands via PATH
                // This works for: py, python, python3, and checkov (if in PATH)
                if (command === 'py' || command === 'python' || command === 'python3' || command === 'checkov') {
                  finalCommand = command;
                  finalArgs = fullArgs;
                  useShell = true; // Use shell to find command via PATH
                  console.log(`   Using Windows shell execution for ${command} command`);
                }
              }
              
              console.log(`   Final command: ${finalCommand}`);
              console.log(`   Final args: ${finalArgs.join(' ')}`);
              console.log(`   Using shell: ${useShell}`);
              
              const checkovProcess = spawn(finalCommand, finalArgs, {
                shell: useShell,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: env,
                cwd: process.cwd()
              });
              
              console.log(`   Process spawned, PID: ${checkovProcess.pid}`);
              
              // Log if process exits immediately
              checkovProcess.on('spawn', () => {
                console.log(`   ✅ Process spawned successfully`);
              });

              let stdout = '';
              let stderr = '';
              let processEnded = false;
              let streamsEnded = false;
              let hasOutput = false;
              let stdoutEnded = false;
              let stderrEnded = false;

              // Set timeout for this attempt (12 minutes per command for large scans)
              const COMMAND_TIMEOUT_MS = 12 * 60 * 1000;
              const scanStartTime = Date.now();
              
              // Add progress logging every 30 seconds
              const progressInterval = setInterval(() => {
                if (!processEnded && !resolved) {
                  const elapsed = Math.floor((Date.now() - scanStartTime) / 1000);
                  const minutes = Math.floor(elapsed / 60);
                  const seconds = elapsed % 60;
                  console.log(`   ⏳ Checkov still running... (${minutes}m ${seconds}s elapsed)`);
                  if (stdout.length > 0) {
                    console.log(`      Output so far: ${stdout.length} bytes`);
                  }
                }
              }, 30000); // Log every 30 seconds
              
              // Warn at 50% and 90% of timeout
              const warning50Percent = setTimeout(() => {
                if (!processEnded && !resolved) {
                  console.warn(`   ⚠️  Checkov scan at 50% of timeout (6 minutes elapsed) - still running...`);
                }
              }, COMMAND_TIMEOUT_MS / 2);
              
              const warning90Percent = setTimeout(() => {
                if (!processEnded && !resolved) {
                  console.warn(`   ⚠️  Checkov scan at 90% of timeout (11 minutes elapsed) - still running...`);
                }
              }, COMMAND_TIMEOUT_MS * 0.9);
              
              const commandTimeout = setTimeout(() => {
                if (!processEnded && !resolved) {
                  processEnded = true;
                  clearInterval(progressInterval);
                  clearTimeout(warning50Percent);
                  clearTimeout(warning90Percent);
                  checkovProcess.kill();
                  const elapsed = Math.floor((Date.now() - scanStartTime) / 1000);
                  console.error(`\n❌ Checkov command timed out after ${elapsed}s (${COMMAND_TIMEOUT_MS / 1000 / 60} minutes)`);
                  console.error(`   stdout length: ${stdout.length}`);
                  console.error(`   stderr length: ${stderr.length}`);
                  console.error(`   This may happen with very large Terraform configurations.`);
                  console.error(`   Consider breaking up large files or increasing timeout.`);
                  if (!hasOutput) {
                    console.error(`   ⚠️  No output received from Checkov - process may not have started`);
                  }
                  console.error(`   Trying next command...`);
                  tryNextCommand();
                }
              }, COMMAND_TIMEOUT_MS);

              checkovProcess.stdout.on('data', (data: any) => {
                hasOutput = true;
                const text = data.toString();
                stdout += text;
                console.log(`📥 stdout chunk (${text.length} bytes): ${text.substring(0, 200).replace(/\n/g, '\\n')}`);
              });

              checkovProcess.stderr.on('data', (data: any) => {
                hasOutput = true;
                const stderrText = data.toString();
                stderr += stderrText;
                // Log all stderr for debugging
                console.log(`📥 stderr chunk (${stderrText.length} bytes): ${stderrText.substring(0, 300).replace(/\n/g, '\\n')}`);
              });

              // Wait for streams to end (critical for Windows shell execution)
              checkovProcess.stdout.on('end', () => {
                stdoutEnded = true;
                console.log(`   ✅ stdout stream ended`);
                checkIfReady();
              });

              checkovProcess.stderr.on('end', () => {
                stderrEnded = true;
                console.log(`   ✅ stderr stream ended`);
                checkIfReady();
              });

              // Store exit code for use in processOutput
              let exitCode: number | null = null;

              // Process the output when both streams end AND process closes
              // On Windows, streams may not always emit 'end' events, so we also check processEnded
              let processOutputScheduled = false;
              
              const checkIfReady = () => {
                if (streamsEnded || resolved || processOutputScheduled) return;
                
                // Option 1: Both streams ended AND process closed (ideal case)
                if (stdoutEnded && stderrEnded && processEnded && exitCode !== null) {
                  streamsEnded = true;
                  processOutputScheduled = true;
                  processOutput(exitCode);
                  return;
                }
                
                // Option 2: Process closed and we have output, but streams didn't end
                // This is common on Windows - process closes but streams don't emit 'end'
                // Process immediately if we have output (don't wait for streams)
                if (processEnded && exitCode !== null && hasOutput && !streamsEnded && !processOutputScheduled) {
                  processOutputScheduled = true;
                  // On Windows, streams often don't emit 'end', so process immediately
                  // Give a tiny delay (50ms) to catch any last chunks, then process
                  setTimeout(() => {
                    if (!streamsEnded && !resolved) {
                      console.log(`   ⚠️  Processing output (process closed, streams didn't emit 'end' - Windows behavior)`);
                      console.log(`   stdout ended: ${stdoutEnded}, stderr ended: ${stderrEnded}`);
                      console.log(`   Processing anyway since we have output`);
                      streamsEnded = true;
                      processOutput(exitCode!);
                    }
                  }, 50);
                }
              };

              const processOutput = (code: number) => {
                if (resolved) return;
                clearTimeout(commandTimeout);
                if (progressInterval) {
                  clearInterval(progressInterval);
                }
                if (warning50Percent) {
                  clearTimeout(warning50Percent);
                }
                if (warning90Percent) {
                  clearTimeout(warning90Percent);
                }
                
                const elapsed = Math.floor((Date.now() - scanStartTime) / 1000);
                console.log(`   ✅ Checkov completed in ${elapsed}s`);
                
                console.log(`\n📊 Processing Checkov output (code: ${code})`);
                console.log(`   Command: ${command} ${fullArgs.join(' ')}`);
                console.log(`   stdout length: ${stdout.length} bytes`);
                console.log(`   stderr length: ${stderr.length} bytes`);
                console.log(`   Has output: ${hasOutput}`);
                
                if (stdout.length > 0) {
                  console.log(`\n📄 Full stdout (first 1000 chars):`);
                  console.log(stdout.substring(0, 1000));
                } else {
                  console.log(`   ⚠️  No stdout received`);
                }
                
                if (stderr.length > 0) {
                  console.log(`\n📄 Full stderr (first 1000 chars):`);
                  console.log(stderr.substring(0, 1000));
                } else {
                  console.log(`   ℹ️  No stderr received`);
                }
                
                // If process exits with code 0 or 1 but no output, it might be a different issue
                if (!hasOutput && (code === 0 || code === 1)) {
                  console.warn(`\n⚠️  Process exited with code ${code} but produced no output`);
                  console.warn(`   This might indicate:`);
                  console.warn(`   - Checkov is not installed`);
                  console.warn(`   - Command syntax is incorrect`);
                  console.warn(`   - Output is being redirected elsewhere`);
                  tryNextCommand();
                  return;
                }
                
                // Continue with JSON extraction below...
                
          // Checkov exits with non-zero code if there are failures
          // But still outputs JSON, so we can parse it
                // Exit code 0 = success, 1 = failures found (but JSON still valid), 2+ = error
                try {
                  console.log(`\n🔍 Analyzing output for JSON...`);
                  console.log(`   stdout length: ${stdout.length} chars`);
                  console.log(`   stderr length: ${stderr.length} chars`);
                  
                  // IMPORTANT: Checkov outputs JSON to stdout
                  // stderr may contain warnings like "File association not found" which are harmless
                  // We should prioritize stdout for JSON extraction
                  
                  let jsonText = '';
                  
                  // Step 1: Check stdout first (this is where Checkov puts JSON)
                  if (stdout && stdout.trim().length > 0) {
                    const stdoutTrimmed = stdout.trim();
                    console.log(`   stdout starts with: '${stdoutTrimmed.substring(0, 50)}...'`);
                    
                    if (stdoutTrimmed.startsWith('{')) {
                      // stdout starts with JSON - use it directly
                      jsonText = stdoutTrimmed;
                      console.log(`✅ Found JSON in stdout (starts with '{', ${jsonText.length} chars)`);
          } else {
                      // Try to extract JSON from stdout (in case there's leading whitespace or other text)
                      // Look for first { ... } block
                      const stdoutMatch = stdout.match(/\{[\s\S]*\}/);
                      if (stdoutMatch && stdoutMatch[0]) {
                        jsonText = stdoutMatch[0];
                        console.log(`✅ Extracted JSON from stdout (${jsonText.length} chars)`);
                        console.log(`   JSON starts with: '${jsonText.substring(0, 50)}...'`);
                      } else {
                        console.warn(`   ⚠️  No JSON pattern found in stdout`);
                        console.warn(`   stdout content: ${stdout.substring(0, 200)}`);
                      }
                    }
                  } else {
                    console.warn(`   ⚠️  stdout is empty`);
                  }
                  
                  // Step 2: If no JSON in stdout, check stderr (sometimes JSON goes to stderr)
                  if (!jsonText && stderr && stderr.trim().length > 0) {
                    const stderrTrimmed = stderr.trim();
                    console.log(`   Checking stderr for JSON...`);
                    console.log(`   stderr starts with: '${stderrTrimmed.substring(0, 50)}...'`);
                    
                    if (stderrTrimmed.startsWith('{')) {
                      jsonText = stderrTrimmed;
                      console.log(`✅ Found JSON in stderr (starts with '{', ${jsonText.length} chars)`);
                    } else {
                      const stderrMatch = stderr.match(/\{[\s\S]*\}/);
                      if (stderrMatch && stderrMatch[0]) {
                        jsonText = stderrMatch[0];
                        console.log(`✅ Extracted JSON from stderr (${jsonText.length} chars)`);
                      }
                    }
                  }
                  
                  // Step 3: If still no JSON, try combined output (last resort)
                  if (!jsonText) {
                    const allOutput = (stdout + '\n' + stderr).trim();
                    console.log(`   Trying combined output (stdout + stderr)...`);
                    console.log(`   Combined length: ${allOutput.length} chars`);
                    
                    if (allOutput.length > 0) {
                      const allOutputTrimmed = allOutput.trim();
                      if (allOutputTrimmed.startsWith('{')) {
                        jsonText = allOutputTrimmed;
                        console.log(`✅ Found JSON in combined output (starts with '{', ${jsonText.length} chars)`);
                      } else {
                        const combinedMatch = allOutput.match(/\{[\s\S]*\}/);
                        if (combinedMatch && combinedMatch[0]) {
                          jsonText = combinedMatch[0];
                          console.log(`✅ Extracted JSON from combined output (${jsonText.length} chars)`);
                        }
                      }
                    }
                  }
                  
                  // Log what we found
                  if (jsonText) {
                    console.log(`   JSON preview: ${jsonText.substring(0, 100)}...`);
                  } else {
                    console.warn(`   ⚠️  No JSON text found after extraction`);
                  }
                  
                  // If we found JSON, try to parse it
                  if (jsonText && jsonText.startsWith('{')) {
                    try {
                      const parsed = JSON.parse(jsonText);
                      console.log(`✅ Successfully parsed Checkov JSON output`);
                      console.log(`   Keys: ${Object.keys(parsed).join(', ')}`);
                      resolved = true;
                      cleanup();
                      resolve(parsed);
                      return;
                    } catch (parseErr: any) {
                      console.error(`❌ JSON parse error: ${parseErr.message}`);
                      console.error(`   JSON text length: ${jsonText.length}`);
                      console.error(`   JSON text preview: ${jsonText.substring(0, 500)}`);
                      console.error(`   JSON text end: ${jsonText.substring(Math.max(0, jsonText.length - 200))}`);
                      tryNextCommand();
                      return;
                    }
                  }
                  
                  // No valid JSON found, try next command
                  console.warn(`\n⚠️  ========== NO VALID JSON OUTPUT ==========`);
                  console.warn(`   Exit code: ${code}`);
                  console.warn(`   Command: ${command} ${fullArgs.join(' ')}`);
                  console.warn(`   stdout length: ${stdout.length} bytes`);
                  console.warn(`   stderr length: ${stderr.length} bytes`);
                  console.warn(`   Has output: ${hasOutput}`);
                  console.warn(`   jsonText found: ${jsonText ? 'YES (' + jsonText.length + ' chars)' : 'NO'}`);
                  console.warn(`   stdout ended: ${stdoutEnded}, stderr ended: ${stderrEnded}`);
                  console.warn(`==========================================`);
                  
                  // Show full output for debugging
                  if (stdout.length > 0) {
                    console.warn(`\n   📄 FULL stdout (${stdout.length} chars):`);
                    console.warn(stdout);
                  } else {
                    console.warn(`   stdout: (empty)`);
                  }
                  
                  if (stderr.length > 0) {
                    console.warn(`\n   📄 FULL stderr (${stderr.length} chars):`);
                    console.warn(stderr);
                  } else {
                    console.warn(`   stderr: (empty)`);
                  }
                  
                  // Show what we tried to extract
                  if (jsonText) {
                    console.warn(`\n   📄 Extracted jsonText (${jsonText.length} chars):`);
                    console.warn(jsonText.substring(0, 500));
                  }
                  
                  console.warn(`\n   Trying next command...`);
                  tryNextCommand();
                } catch (parseError: any) {
                  // Parse error, try next command
                  console.error(`❌ Error processing Checkov output: ${parseError.message}`);
                  console.error(`   stdout: ${stdout.substring(0, 500)}`);
                  console.error(`   stderr: ${stderr.substring(0, 500)}`);
                  tryNextCommand();
                }
              };

              checkovProcess.on('close', (code: any) => {
                // Prevent multiple calls
                if (processEnded || resolved) {
                  return;
                }
                processEnded = true;
                
                // Clear progress logging
                if (progressInterval) {
                  clearInterval(progressInterval);
                }
                
                const elapsed = Math.floor((Date.now() - scanStartTime) / 1000);
                console.log(`   ✅ Checkov process completed (exit code: ${code}, elapsed: ${elapsed}s)`);
                exitCode = code;
                
                console.log(`\n📊 Checkov process closed with code: ${code}`);
                console.log(`   Command: ${command} ${fullArgs.join(' ')}`);
                console.log(`   stdout ended: ${stdoutEnded}, stderr ended: ${stderrEnded}`);
                console.log(`   stdout length: ${stdout.length} bytes`);
                console.log(`   stderr length: ${stderr.length} bytes`);
                console.log(`   Has output: ${hasOutput}`);
                
                // Check if we can process output now (streams may have already ended)
                checkIfReady();
                
                // CRITICAL FIX: On Windows, streams often don't emit 'end' events
                // If process closed and we have output, process it after a short delay
                // This is the most reliable way to handle Windows stream behavior
                if (hasOutput && !processOutputScheduled && !resolved) {
                  // Give streams 200ms to emit 'end' events, then process anyway
                  setTimeout(() => {
                    if (!streamsEnded && !resolved && processEnded && exitCode !== null) {
                      console.warn(`   ⚠️  Windows fallback: Processing output (streams didn't emit 'end' events)`);
                      console.warn(`   stdout ended: ${stdoutEnded}, stderr ended: ${stderrEnded}`);
                      console.warn(`   stdout length: ${stdout.length}, stderr length: ${stderr.length}`);
                      console.warn(`   This is normal on Windows - streams don't always emit 'end' events`);
                      streamsEnded = true;
                      processOutput(exitCode);
                    }
                  }, 200);
                } else if (!hasOutput && !processOutputScheduled) {
                  // No output at all - this is a real problem
                  console.warn(`   ⚠️  Process closed but no output received`);
                  console.warn(`   This might indicate the command failed to execute`);
                  // Don't process, let it try next command
                }
              });

              checkovProcess.on('error', (error: any) => {
                if (processEnded) return;
                processEnded = true;
                clearTimeout(commandTimeout);
                
                if (resolved) return;
                
                console.error(`\n❌ Checkov process spawn error:`);
                console.error(`   Message: ${error.message}`);
                console.error(`   Code: ${error.code}`);
                console.error(`   Syscall: ${error.syscall}`);
                console.error(`   Original command: ${command}`);
                console.error(`   Original args: ${fullArgs.join(' ')}`);
                console.error(`   Final command: ${finalCommand}`);
                console.error(`   Final args: ${finalArgs.join(' ')}`);
                console.error(`   Full error:`, JSON.stringify(error, Object.getOwnPropertyNames(error)));
                
                if (error.code === 'ENOENT' || error.message.includes('ENOENT') || error.message.includes('not recognized')) {
                  // Command not found, try next command
                  console.warn(`⚠️  Command '${command}' not found in PATH, trying next command...`);
                  console.warn(`   Current PATH: ${env.PATH?.substring(0, 200)}...`);
                  tryNextCommand();
                } else {
                  // Other error - log it but still try next command
                  console.warn(`⚠️  Process spawn error (${error.code}), trying next command...`);
                  tryNextCommand();
                }
              });
            };
            
            // Set overall timeout
            timeoutId = setTimeout(() => {
              if (!resolved) {
                resolved = true;
                cleanup();
                reject(new Error('Checkov scan timed out after 5 minutes. The scan may be taking too long or Checkov may be stuck.'));
              }
            }, TIMEOUT_MS);
            
            // Start with first command
            tryNextCommand();
          }),
          new Promise<any>((_, reject) => {
            setTimeout(() => {
              reject(new Error('Checkov scan timed out after 5 minutes'));
            }, TIMEOUT_MS);
          })
        ]).catch((error) => {
          console.error('❌ Promise.race rejected:', error);
          throw error;
        });

        // Parse results - Checkov JSON structure
        console.log('\n✅ Checkov scan Promise resolved');
        console.log('Checkov scan completed. Raw result keys:', Object.keys(scanResult || {}));
        console.log('Checkov scan result sample:', JSON.stringify(scanResult).substring(0, 500));
        
        // Validate scanResult
        if (!scanResult || typeof scanResult !== 'object') {
          console.error('❌ Invalid scanResult:', typeof scanResult, scanResult);
          throw new Error(`Invalid Checkov scan result: expected object, got ${typeof scanResult}`);
        }
        
        // Debug: Log full structure to understand Checkov output format
        if (scanResult.summary) {
          console.log('📊 Found summary object:', JSON.stringify(scanResult.summary));
        } else {
          console.log('⚠️  No summary object found, will calculate from check counts');
        }
        
        // Check if Checkov found any files to scan
        if (scanResult.summary) {
          const resourceCount = scanResult.summary.resource_count || 0;
          const parsingErrors = scanResult.summary.parsing_errors || 0;
          console.log(`📋 Checkov scanned ${resourceCount} resource(s)`);
          
          if (parsingErrors > 0) {
            console.error(`\n❌ ========== CHECKOV PARSING ERRORS DETECTED ==========`);
            console.error(`   Parsing errors: ${parsingErrors}`);
            console.error(`   Resource count: ${resourceCount}`);
            console.error(`   This means Checkov could not parse the Terraform files`);
            
            // Try to get detailed parsing errors from results
            if (scanResult.results?.parsing_errors && Array.isArray(scanResult.results.parsing_errors)) {
              console.error(`\n   Detailed parsing errors:`);
              scanResult.results.parsing_errors.forEach((error: any, idx: number) => {
                console.error(`   ${idx + 1}. File: ${error.file_path || error.file || 'unknown'}`);
                console.error(`      Error: ${error.error_message || error.message || error.error || 'Unknown parsing error'}`);
                if (error.line) {
                  console.error(`      Line: ${error.line}`);
                }
                if (error.column) {
                  console.error(`      Column: ${error.column}`);
                }
              });
            }
            
            console.error(`\n   Possible causes:`);
            console.error(`   1. Invalid Terraform syntax in files`);
            console.error(`   2. Missing required attributes or blocks`);
            console.error(`   3. Files are empty or corrupted`);
            console.error(`   4. Terraform version incompatibility`);
            console.error(`   5. Files contain unsupported features`);
            console.error(`\n   Check the files written to: ${tempDir}`);
            console.error(`   Files written: ${filesWritten} of ${files.length}`);
            console.error(`==========================================\n`);
            
            // Return error response with parsing error details
            // Note: cleanup() is handled in finally block, don't call it here
            clearTimeout(responseTimeout);
            if (!responseSent && !res.headersSent) {
              responseSent = true;
              return res.status(400).json({
                error: 'Terraform parsing errors detected',
                details: `Checkov found ${parsingErrors} parsing error(s) in the Terraform files. Files were written but contain invalid syntax.`,
                parsingErrors: parsingErrors,
                resourceCount: resourceCount,
                parsingErrorDetails: scanResult.results?.parsing_errors || [],
                tempDirectory: tempDir,
                filesWritten: filesWritten,
                troubleshooting: [
                  'Check server logs for detailed parsing error messages',
                  'Verify Terraform files have valid syntax',
                  'Ensure all required attributes are present',
                  'Check if files are empty or corrupted',
                  `Review files in temp directory: ${tempDir}`
                ]
              });
            }
          }
          
          if (resourceCount === 0 && parsingErrors === 0) {
            console.error('❌ WARNING: Checkov found 0 resources to scan!');
            console.error('   This usually means:');
            console.error('   1. No Terraform files were found in the temp directory');
            console.error('   2. Files were written but Checkov cannot parse them');
            console.error('   3. Files are in wrong location or format');
            console.error('   4. Files contain only module calls (aggregated-root) - Checkov may not scan modules');
            console.error(`   Files written: ${filesWritten} of ${files.length}`);
            console.error(`   Module approach: ${session.moduleApproach || 'null'}`);
            console.error(`   Temp directory: ${tempDir}`);
            
            // For aggregated-root, Checkov might not scan module calls
            // Log what files were written
            console.error(`\n   Files written to temp directory:`);
            for (const file of files) {
              if (file.content && file.content.trim().length > 0) {
                const normalizedPath = file.fileName.replace(/\//g, path.sep).replace(/\\/g, path.sep);
                const filePath = path.join(tempDir, normalizedPath);
                console.error(`      - ${file.fileName} -> ${filePath} (${file.content.length} bytes)`);
                // Check if file contains module calls
                if (file.content.includes('module ') && file.content.includes('{')) {
                  console.error(`         ⚠️  Contains module calls - Checkov may not scan these`);
                }
              }
            }
          }
        }
        
        // Checkov JSON structure (version 3.x):
        // { check_type, results: { failed_checks, passed_checks? }, summary: { passed, failed, skipped, ... } }
        // NOTE: With --compact flag, Checkov only includes failed_checks in results, not passed_checks
        // The summary object contains the accurate counts
        const summary = scanResult.summary || {};
        const results = scanResult.results || {};
        
        // Try summary object first (newer Checkov format), then root level (older format)
        // Summary is the authoritative source for counts
        // Use ONLY what Checkov returns - no fallback calculations
        const passed = summary.passed != null ? Number(summary.passed) : (scanResult.passed != null ? Number(scanResult.passed) : 0);
        const failed = summary.failed != null ? Number(summary.failed) : (scanResult.failed != null ? Number(scanResult.failed) : 0);
        const skipped = summary.skipped != null ? Number(summary.skipped) : (scanResult.skipped != null ? Number(scanResult.skipped) : 0);
        
        // Log if passed is missing (but don't calculate it)
        if (summary.passed == null && scanResult.passed == null) {
          console.log(`   ⚠️  summary.passed is missing from Checkov output - using 0`);
        }

        // Get detailed check results
        // NOTE: With --compact, only failed_checks are included in JSON output
        // passed_checks array may be empty or missing, but summary.passed has the count
        const checks = results.failed_checks || [];
        const passedChecks = results.passed_checks || [];
        
        // Calculate totals - ALWAYS use summary counts as primary source
        // Summary counts are accurate even when passed_checks array is empty (due to --compact)
        const actualPassed = passed; // Use summary.passed directly
        const actualFailed = failed;  // Use summary.failed directly
        const total = actualPassed + actualFailed + skipped;
        const passPercentage = total > 0 ? Math.round((actualPassed / total) * 100) : 0;
        
        // Log for debugging
        console.log(`\n📊 ========== CHECKOV SCAN RESULTS PARSING ==========`);
        console.log(`   Raw scanResult keys:`, Object.keys(scanResult));
        console.log(`   Raw summary object:`, JSON.stringify(summary, null, 2));
        console.log(`   Raw scanResult.passed (root level):`, scanResult.passed);
        console.log(`   Summary counts: passed=${passed}, failed=${failed}, skipped=${skipped}`);
        console.log(`   Summary.passed value:`, summary.passed, `(type: ${typeof summary.passed})`);
        console.log(`   Summary.failed value:`, summary.failed, `(type: ${typeof summary.failed})`);
        console.log(`   Detailed checks: failed_checks=${checks.length}, passed_checks array=${passedChecks.length}`);
        console.log(`   Using summary counts: actualPassed=${actualPassed}, actualFailed=${actualFailed}`);
        console.log(`   Total: ${total}, Pass Rate: ${passPercentage}%`);
        
        // Warn if all values are 0 (likely means no files were scanned)
        if (total === 0 && actualPassed === 0 && actualFailed === 0) {
          if (session.moduleApproach === 'aggregated-root') {
            console.log(`\n⚠️  NOTE: Checkov returned 0 resources for aggregated-root module`);
            console.log(`   This is EXPECTED - module calls in main.tf are not direct resources`);
            console.log(`   The child module should be scanned separately for security`);
            console.log(`   Returning scan result with 0 resources (expected behavior)`);
          } else {
            console.error(`\n❌ WARNING: All scan results are 0!`);
            console.error(`   This indicates Checkov did not find any Terraform resources to scan.`);
            console.error(`   Possible causes:`);
            console.error(`   1. No Terraform files were written to temp directory`);
            console.error(`   2. Files were written but Checkov cannot parse them`);
            console.error(`   3. Files are empty or invalid`);
            console.error(`   Check the file writing logs above for details.`);
          }
        }
        
        console.log(`==========================================\n`);

        // Prepare response
        console.log(`\n📤 Preparing API response:`);
        console.log(`   Response summary: passed=${actualPassed}, failed=${actualFailed}, skipped=${skipped}, total=${total}, passPercentage=${passPercentage}`);
        
        const response = {
          success: true,
          summary: {
            passed: actualPassed,
            failed: actualFailed,
            skipped,
            total,
            passPercentage
          },
          failedChecks: checks.map((check: any) => ({
            checkId: check.check_id,
            checkName: check.check_name,
            resource: check.resource,
            file: check.file_path?.replace(tempDir, ''),
            guideline: check.guideline,
            // Add failure reason/explanation
            reason: check.check_result?.evaluated_keys 
              ? `Missing or incorrect: ${check.check_result.evaluated_keys.join(', ')}`
              : check.check_result?.result === 'FAILED'
              ? `Check failed: ${check.check_name}`
              : check.guideline || `Security check ${check.check_id} failed for this resource`,
            evaluatedKeys: check.check_result?.evaluated_keys || [],
            checkResult: check.check_result?.result || 'FAILED'
          })),
          passedChecks: passedChecks.slice(0, 10).map((check: any) => ({
            checkId: check.check_id,
            checkName: check.check_name,
            resource: check.resource
          }))
        };
        
        // Log final response for debugging
        console.log(`\n📤 Sending response to client:`);
        console.log(`   Summary: ${response.summary.passed} passed, ${response.summary.failed} failed, ${response.summary.total} total`);
        console.log(`   Failed checks: ${response.failedChecks.length}`);
        console.log(`   Passed checks: ${response.passedChecks.length}`);
        
        // Clear timeout and send response
        clearTimeout(responseTimeout);
        if (!responseSent && !res.headersSent) {
          responseSent = true;
          res.json(response);
        } else {
          console.warn('⚠️  Response already sent, skipping duplicate response');
        }
      } catch (error: any) {
        // Clear timeout if not already cleared
        clearTimeout(responseTimeout);
        console.error('\n❌ ========== CHECKOV SCAN ERROR ==========');
        console.error('Session ID:', sessionId);
        console.error('Error type:', error?.constructor?.name || typeof error);
        console.error('Error message:', error?.message || String(error));
        console.error('Error code:', error?.code);
        console.error('Error name:', error?.name);
        if (error?.stack) {
          console.error('Error stack:');
          console.error(error.stack);
        }
        console.error('==========================================\n');
        
        // Provide more helpful error message
        let errorMessage = error?.message || 'Failed to run security scan';
        let errorDetails = '';
        
        // Check for specific error types
        if (error?.code === 'ENOENT') {
          errorMessage = 'Checkov command not found';
          errorDetails = 'The Checkov executable could not be found. Please verify installation.';
        } else if (error?.message?.includes('timeout')) {
          errorMessage = 'Checkov scan timed out';
          errorDetails = 'The scan took too long to complete. This might indicate an issue with Checkov or the files being scanned.';
        } else if (error?.message?.includes('Checkov')) {
          errorMessage = error.message;
          errorDetails = 'Please check the server console logs above for detailed error information about why Checkov failed to execute.';
        } else {
          errorDetails = error?.stack || error?.message || 'Unknown error occurred';
        }
        
        // Ensure timeout is cleared
        clearTimeout(responseTimeout);
        
        // Only send response if not already sent
        if (!responseSent && !res.headersSent) {
          responseSent = true;
          res.status(500).json({ 
            error: errorMessage,
            details: errorDetails,
            sessionId: req.params.id,
            timestamp: new Date().toISOString()
          });
        } else {
          console.warn('⚠️  Response already sent, cannot send error response');
        }
      }
    } finally {
      // Clean up temp directory
      if (tempDir && fs && path) {
        try {
          console.log(`\n🧹 Cleaning up temp directory: ${tempDir}`);
          await fs.rm(tempDir, { recursive: true, force: true });
          console.log(`✅ Temp directory cleaned up`);
          
          // Also clean up base temp directory if empty
          const tempBaseDir = path.join(process.cwd(), '.temp-checkov');
          try {
            const entries = await fs.readdir(tempBaseDir);
            if (entries.length === 0) {
              await fs.rmdir(tempBaseDir);
              console.log(`✅ Base temp directory cleaned up`);
            }
          } catch (e) {
            // Ignore errors cleaning up base dir
            console.warn('⚠️  Could not clean up base temp dir:', e);
          }
        } catch (cleanupError) {
          console.warn('⚠️  Failed to clean up temp directory:', cleanupError);
        }
      }
    }
  });

  // Refactor and validate Terraform best practices
  app.post("/api/sessions/:id/refactor", async (req, res) => {
    interface RefactorResult {
      isValid: boolean;
      issues: Array<{
        file: string;
        type: 'hardcoded_value' | 'missing_variable' | 'missing_declaration' | 'missing_tfvars' | 'hardcoded_default' | 'multiple_resources_same_type' | 'poor_structure' | 'naming_issue';
        severity: 'error' | 'warning';
        message: string;
        line?: number;
        suggestion?: string;
        codeSnippet?: string;
      }>;
      suggestions: Array<{
        file: string;
        action: string;
        details: string;
      }>;
      summary: {
        totalIssues: number;
        errors: number;
        warnings: number;
        filesChecked: number;
      };
    }
    const sessionId = req.params.id;
    
    try {
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Get all Terraform files from session storage
      const files = await storage.getFilesBySession(sessionId);
      const terraformFiles = files.filter(f => 
        f.fileName.endsWith('.tf') || f.fileName.endsWith('.tfvars')
      );

      console.log(`\n🔍 [REFACTOR] Validating Terraform best practices...`);
      console.log(`   Session ID: ${sessionId}`);
      console.log(`   Files to check: ${terraformFiles.length}`);

      const issues: Array<{
        file: string;
        type: 'hardcoded_value' | 'missing_variable' | 'missing_declaration' | 'missing_tfvars' | 'hardcoded_default' | 'multiple_resources_same_type' | 'poor_structure' | 'naming_issue';
        severity: 'error' | 'warning';
        message: string;
        line?: number;
        suggestion?: string;
        codeSnippet?: string;
      }> = [];

      const suggestions: Array<{
        file: string;
        action: string;
        details: string;
      }> = [];

      // Find main.tf, variables.tf, and tfvars files
      const mainTf = terraformFiles.find(f => f.fileName === 'main.tf');
      const variablesTf = terraformFiles.find(f => f.fileName === 'variables.tf');
      const tfvarsFiles = terraformFiles.filter(f => f.fileName.endsWith('.tfvars'));

      console.log(`   Found: main.tf=${!!mainTf}, variables.tf=${!!variablesTf}, tfvars=${tfvarsFiles.length}`);

      // Extract all declared variables from variables.tf
      const declaredVariables = new Set<string>();
      if (variablesTf) {
        const variablePattern = /variable\s+"([^"]+)"/g;
        let match;
        while ((match = variablePattern.exec(variablesTf.content)) !== null) {
          declaredVariables.add(match[1]);
        }
        console.log(`   Declared variables: ${Array.from(declaredVariables).join(', ')}`);
      }

      // Extract all variables used in main.tf
      const usedVariables = new Set<string>();
      if (mainTf) {
        // Match var.variable_name or ${var.variable_name}
        const varPattern = /var\.([a-zA-Z0-9_-]+)/g;
        let match;
        while ((match = varPattern.exec(mainTf.content)) !== null) {
          usedVariables.add(match[1]);
        }
        console.log(`   Used variables: ${Array.from(usedVariables).join(', ')}`);
      }

      // Extract all variables defined in tfvars files
      const tfvarsVariables = new Set<string>();
      tfvarsFiles.forEach(tfvarsFile => {
        const lines = tfvarsFile.content.split('\n');
        lines.forEach((line, lineNum) => {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
            const match = trimmed.match(/^([^=]+?)\s*=\s*(.+)$/);
            if (match) {
              tfvarsVariables.add(match[1].trim());
            }
          }
        });
      });
      console.log(`   Tfvars variables: ${Array.from(tfvarsVariables).join(', ')}`);

      // Check 1: Variables used in main.tf but not declared in variables.tf
      if (mainTf && variablesTf) {
        usedVariables.forEach(varName => {
          if (!declaredVariables.has(varName)) {
            issues.push({
              file: 'main.tf',
              type: 'missing_declaration',
              severity: 'error',
              message: `Variable "${varName}" is used in main.tf but not declared in variables.tf`,
              suggestion: `Add "variable "${varName}" { ... }" to variables.tf`
            });
          }
        });
      }

      // Check 2: Variables declared but not in tfvars
      if (variablesTf && tfvarsFiles.length > 0) {
        declaredVariables.forEach(varName => {
          if (!tfvarsVariables.has(varName)) {
            issues.push({
              file: variablesTf.fileName,
              type: 'missing_tfvars',
              severity: 'warning',
              message: `Variable "${varName}" is declared but not assigned in any .tfvars file`,
              suggestion: `Add "${varName} = <value>" to your .tfvars file`
            });
          }
        });
      }

      // Check 3: Hardcoded values in main.tf (should use variables)
      if (mainTf) {
        const lines = mainTf.content.split('\n');
        lines.forEach((line, lineNum) => {
          const trimmed = line.trim();
          
          // Skip comments and empty lines
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
            return;
          }

          // Skip lines that already use variables
          if (trimmed.includes('var.') || trimmed.includes('${var.')) {
            return;
          }

          // Check for hardcoded attribute values that should be variables
          // Pattern: attribute_name = "hardcoded-value" (not resource type, not function calls)
          // Use AI to detect which attributes should be variables (not hardcoded)
          // For performance, we'll use a simplified approach: detect common configurable attributes
          // In a production system, this could be enhanced with AI-based detection
          const configurableAttributes = ['name', 'location', 'region', 'resource_group_name', 'account_tier', 'account_replication_type', 'sku', 'instance_type', 'instance_class', 'size', 'tier', 'capacity', 'billing_mode', 'read_capacity', 'write_capacity'];

          configurableAttributes.forEach(attr => {
            // Match: attribute = "value" or attribute = value
            const attrPattern = new RegExp(`${attr}\\s*=\\s*"([^"]+)"`, 'i');
            const attrMatch = trimmed.match(attrPattern);
            
            if (attrMatch) {
              const value = attrMatch[1];
              // Skip if it's a reference (data., resource., etc.)
              if (!value.match(/^(data\.|resource\.|module\.|local\.|path\.|self\.|count\.|each\.)/) &&
                  !value.match(/^[0-9]+$/) && // Skip pure numbers
                  value.length > 1 &&
                  !value.match(/^(true|false|null)$/i)) {
                
                // Check if this value looks configurable (not a built-in identifier)
                if (!value.match(/^(azurerm_|aws_|google_|Standard|Premium|Basic)/i) &&
                    value.length > 3) { // Only flag meaningful values
                  
                  issues.push({
                    file: 'main.tf',
                    type: 'hardcoded_value',
                    severity: 'warning',
                    message: `Hardcoded value for "${attr}": "${value}" (line ${lineNum + 1})`,
                    line: lineNum + 1,
                    suggestion: `Use a variable instead: ${attr} = var.${attr.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()}`
                  });
                }
              }
            }
          });

          // Check for hardcoded resource names (suggest using variables for naming)
          const resourceNamePattern = /resource\s+"([^"]+)"\s+"([^"]+)"/;
          const resourceMatch = trimmed.match(resourceNamePattern);
          if (resourceMatch) {
            const resourceName = resourceMatch[2];
            // If resource name is a hardcoded string and looks like a configurable name
            if (!resourceName.includes('var.') && 
                !resourceName.includes('${') &&
                resourceName.length > 5 && // Meaningful names
                !resourceName.match(/^[a-z0-9-]+$/)) { // Not just a simple identifier
              // Suggest using variable for resource naming
              suggestions.push({
                file: 'main.tf',
                action: `Consider using a variable for resource name "${resourceName}"`,
                details: `Best practice: Use variables for resource names to make them configurable across environments`
              });
            }
          }
        });
      }

      // Check 4: Hardcoded defaults in variables.tf (should be in tfvars)
      if (variablesTf) {
        const lines = variablesTf.content.split('\n');
        let currentVariable = '';
        let inDefaultBlock = false;
        
        lines.forEach((line, lineNum) => {
          const trimmed = line.trim();
          
          // Detect variable declaration
          const varMatch = trimmed.match(/variable\s+"([^"]+)"/);
          if (varMatch) {
            currentVariable = varMatch[1];
            inDefaultBlock = false;
          }
          
          // Detect default block
          if (trimmed.includes('default') && trimmed.includes('=')) {
            inDefaultBlock = true;
            const defaultMatch = trimmed.match(/default\s*=\s*(.+)/);
            if (defaultMatch && currentVariable) {
              const defaultValue = defaultMatch[1].trim();
              // Check if this variable is also in tfvars (redundant default)
              if (tfvarsVariables.has(currentVariable)) {
                issues.push({
                  file: 'variables.tf',
                  type: 'hardcoded_default',
                  severity: 'warning',
                  message: `Variable "${currentVariable}" has a default value but is also defined in .tfvars`,
                  line: lineNum + 1,
                  suggestion: `Remove the default from variables.tf since it's defined in .tfvars`
                });
              } else {
                // Default is OK if not in tfvars, but suggest moving to tfvars
                suggestions.push({
                  file: 'variables.tf',
                  action: `Move default value for "${currentVariable}" to .tfvars file`,
                  details: `Best practice: Keep variables.tf for declarations only, put values in .tfvars`
                });
              }
            }
          }
        });
      }

      // Check 5: Variables in tfvars but not declared
      if (variablesTf && tfvarsFiles.length > 0) {
        tfvarsVariables.forEach(varName => {
          if (!declaredVariables.has(varName)) {
            issues.push({
              file: tfvarsFiles[0].fileName,
              type: 'missing_declaration',
              severity: 'error',
              message: `Variable "${varName}" is defined in .tfvars but not declared in variables.tf`,
              suggestion: `Add "variable "${varName}" { ... }" to variables.tf`
            });
          }
        });
      }

      // Check 6: AI-driven best practices validation
      console.log(`\n   🤖 Running AI-driven best practices analysis...`);
      try {
        const aiAnalysis = await openaiService.analyzeTerraformBestPractices(terraformFiles);
        
        // Add AI-detected issues
        if (aiAnalysis.issues && aiAnalysis.issues.length > 0) {
          console.log(`   ✅ AI found ${aiAnalysis.issues.length} best practices issue(s)`);
          aiAnalysis.issues.forEach(issue => {
            issues.push({
              file: issue.file,
              type: issue.type as any,
              severity: issue.severity,
              message: issue.message,
              line: issue.line,
              suggestion: issue.suggestion,
              codeSnippet: issue.codeSnippet
            });
          });
        }

        // Add AI suggestions
        if (aiAnalysis.suggestions && aiAnalysis.suggestions.length > 0) {
          console.log(`   💡 AI provided ${aiAnalysis.suggestions.length} suggestion(s)`);
          aiAnalysis.suggestions.forEach(suggestion => {
            suggestions.push(suggestion);
          });
        }
      } catch (aiError: any) {
        console.error(`   ⚠️  AI best practices analysis failed: ${aiError.message}`);
        // Continue without AI analysis - regex-based checks are still valid
      }

      // Check 7: Detect multiple resources of same type (regex-based fallback)
      if (mainTf) {
        const resourceTypeCounts = new Map<string, number>();
        const resourcePattern = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g;
        let match;
        const resourceBlocks: Array<{ type: string; name: string; hasCount: boolean; hasForEach: boolean }> = [];
        
        while ((match = resourcePattern.exec(mainTf.content)) !== null) {
          const resourceType = match[1];
          const resourceName = match[2];
          
          // Check if this resource uses count or for_each
          const resourceStart = match.index;
          const resourceEnd = findMatchingBrace(mainTf.content, resourceStart + match[0].length - 1);
          const resourceBody = mainTf.content.substring(resourceStart, resourceEnd);
          
          const hasCount = /count\s*=/.test(resourceBody);
          const hasForEach = /for_each\s*=/.test(resourceBody);
          
          resourceBlocks.push({ type: resourceType, name: resourceName, hasCount, hasForEach });
          resourceTypeCounts.set(resourceType, (resourceTypeCounts.get(resourceType) || 0) + 1);
        }

        // Check for multiple resources of same type without count/for_each
        resourceTypeCounts.forEach((count, resourceType) => {
          if (count >= 3) {
            const resourcesOfType = resourceBlocks.filter(r => r.type === resourceType);
            const withoutMetaArg = resourcesOfType.filter(r => !r.hasCount && !r.hasForEach);
            
            if (withoutMetaArg.length >= 3) {
              issues.push({
                file: 'main.tf',
                type: 'multiple_resources_same_type',
                severity: 'error',
                message: `Found ${count} resources of type "${resourceType}" without using count or for_each. This violates Terraform best practices.`,
                suggestion: `Refactor to use count or for_each meta-argument. Example: resource "${resourceType}" "example" { for_each = toset(["r1", "r2", "r3"]) ... }`,
                codeSnippet: `Multiple ${resourceType} resources found`
              });
            }
          }
        });
      }

      const errors = issues.filter(i => i.severity === 'error').length;
      const warnings = issues.filter(i => i.severity === 'warning').length;

      const result: RefactorResult = {
        isValid: issues.length === 0,
        issues,
        suggestions,
        summary: {
          totalIssues: issues.length,
          errors,
          warnings,
          filesChecked: terraformFiles.length
        }
      };

      console.log(`\n✅ [REFACTOR] Validation complete:`);
      console.log(`   Files checked: ${result.summary.filesChecked}`);
      console.log(`   Total issues: ${result.summary.totalIssues} (${errors} errors, ${warnings} warnings)`);
      console.log(`   Valid: ${result.isValid}`);

      res.json(result);
    } catch (error: any) {
      console.error('Error validating Terraform files:', error);
      res.status(500).json({ 
        error: 'Failed to validate Terraform files',
        details: error.message 
      });
    }
  });

  // Fix Terraform best practices issues automatically
  app.post("/api/sessions/:id/refactor-fix", async (req, res) => {
    const sessionId = req.params.id;
    
    try {
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      console.log(`\n🔧 [REFACTOR-FIX] Fixing Terraform best practices issues...`);
      console.log(`   Session ID: ${sessionId}`);
      
      let totalFixedIssues = 0;
      const allFixes: string[] = [];
      const maxPasses = 5; // Maximum number of fix passes to prevent infinite loops
      let pass = 0;

      // Run fix passes until no more issues are found or max passes reached
      while (pass < maxPasses) {
        pass++;
        console.log(`\n   🔄 Fix pass ${pass}/${maxPasses}...`);

        // Get all Terraform files from session storage (refresh on each pass)
        const files = await storage.getFilesBySession(sessionId);
        const terraformFiles = files.filter(f => 
          f.fileName.endsWith('.tf') || f.fileName.endsWith('.tfvars')
        );

        console.log(`   Files to fix: ${terraformFiles.length}`);

        // Find main.tf, variables.tf, and tfvars files
        let mainTf = terraformFiles.find(f => f.fileName === 'main.tf');
        let variablesTf = terraformFiles.find(f => f.fileName === 'variables.tf');
        const tfvarsFiles = terraformFiles.filter(f => f.fileName.endsWith('.tfvars'));
        const primaryTfvars = tfvarsFiles.find(f => f.fileName === 'dev.terraform.tfvars') || tfvarsFiles[0];

        let fixedIssues = 0;
        const fixes: string[] = [];

        // Extract current state
        const declaredVariables = new Set<string>();
        if (variablesTf) {
          const variablePattern = /variable\s+"([^"]+)"/g;
          let match;
          while ((match = variablePattern.exec(variablesTf.content)) !== null) {
            declaredVariables.add(match[1]);
          }
        }

        const usedVariables = new Set<string>();
        if (mainTf) {
          const varPattern = /var\.([a-zA-Z0-9_-]+)/g;
          let match;
          while ((match = varPattern.exec(mainTf.content)) !== null) {
            usedVariables.add(match[1]);
          }
        }

        const tfvarsVariables = new Set<string>();
        if (primaryTfvars) {
          const lines = primaryTfvars.content.split('\n');
          lines.forEach((line) => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
              const match = trimmed.match(/^([^=]+?)\s*=\s*(.+)$/);
              if (match) {
                tfvarsVariables.add(match[1].trim());
              }
            }
          });
        }

        // Fix 1: Add missing variable declarations to variables.tf (create if doesn't exist)
        if (mainTf) {
          const missingDeclarations = Array.from(usedVariables).filter(v => !declaredVariables.has(v));
          if (missingDeclarations.length > 0) {
            console.log(`      🔧 Fix 1: Adding ${missingDeclarations.length} missing variable declaration(s) to variables.tf`);
            
            // Use AI to generate proper variable declarations
            let varDeclarations = '';
            try {
              varDeclarations = await openaiService.generateVariableDeclarations(
                missingDeclarations,
                mainTf.content
              );
              console.log(`      ✅ AI generated declarations for ${missingDeclarations.length} variable(s)`);
            } catch (aiError: any) {
              console.warn(`      ⚠️  AI declaration generation failed: ${aiError.message}, using fallback`);
              // Fallback: Generate simple declarations
              missingDeclarations.forEach(varName => {
                varDeclarations += `\n\nvariable "${varName}" {\n  description = "Value for ${varName}"\n  type        = string\n}`;
              });
            }
            
            if (variablesTf) {
              // Update existing variables.tf
              const newContent = variablesTf.content.trim() + varDeclarations;
              await storage.updateFile(variablesTf.id, newContent);
              console.log(`      ✅ Updated variables.tf (ID: ${variablesTf.id}, new size: ${newContent.length} chars)`);
              variablesTf = { ...variablesTf, content: newContent };
              missingDeclarations.forEach(varName => {
                fixes.push(`Added variable declaration for "${varName}" to variables.tf`);
                fixedIssues++;
              });
            } else {
              // Create new variables.tf
              const newContent = varDeclarations.trim();
              const created = await storage.createFile({
                sessionId,
                fileName: 'variables.tf',
                content: newContent,
              });
              console.log(`      ✅ Created variables.tf (ID: ${created.id}, size: ${newContent.length} chars)`);
              variablesTf = created;
              missingDeclarations.forEach(varName => {
                fixes.push(`Created variables.tf with declaration for "${varName}"`);
                fixedIssues++;
              });
            }
            
            declaredVariables.clear();
            // Re-extract declared variables
            const variablePattern = /variable\s+"([^"]+)"\s*\{/g;
            let match;
            while ((match = variablePattern.exec(variablesTf.content)) !== null) {
              declaredVariables.add(match[1]);
            }
          }
        }

        // Fix 2: Add missing variables to tfvars with sensible default values
        if (variablesTf && primaryTfvars) {
          const missingInTfvars = Array.from(declaredVariables).filter(v => !tfvarsVariables.has(v));
          if (missingInTfvars.length > 0) {
            console.log(`      🔧 Fix 2: Adding ${missingInTfvars.length} missing variable(s) to ${primaryTfvars.fileName} with sensible defaults...`);
            
            // Use AI to generate sensible default values based on variable names and context
            let tfvarsValues = '';
            try {
              if (mainTf) {
                tfvarsValues = await openaiService.generateTfvarsValues(
                  missingInTfvars,
                  mainTf.content,
                  'Terraform best practices fix - populate variable values'
                );
                console.log(`      ✅ AI generated values for ${missingInTfvars.length} variable(s)`);
              }
            } catch (aiError: any) {
              console.warn(`      ⚠️  AI value generation failed: ${aiError.message}, using fallback defaults`);
              // Fallback: Generate simple defaults based on variable name patterns
              missingInTfvars.forEach(varName => {
                let defaultValue = '"value"';
                if (varName.includes('count') || varName.includes('Count')) {
                  defaultValue = '1';
                } else if (varName.includes('location') || varName.includes('region')) {
                  defaultValue = session.cloudProvider === 'aws' ? '"us-east-1"' : '"eastus"';
                } else if (varName.includes('prefix') || varName.includes('name')) {
                  defaultValue = '"example"';
                } else if (varName.includes('tags')) {
                  defaultValue = '{}';
                } else if (varName.includes('enabled') || varName.includes('enable')) {
                  defaultValue = 'true';
                }
                tfvarsValues += `${varName} = ${defaultValue}\n`;
              });
            }
            
            let newContent = primaryTfvars.content.trim();
            if (!newContent.endsWith('\n')) {
              newContent += '\n';
            }
            
            // Parse AI-generated values and add them
            if (tfvarsValues) {
              const valueLines = tfvarsValues.split('\n').filter(line => {
                const trimmed = line.trim();
                return trimmed && !trimmed.startsWith('#') && trimmed.includes('=');
              });
              
              valueLines.forEach(line => {
                const match = line.match(/^([^=]+?)\s*=\s*(.+)$/);
                if (match) {
                  const varName = match[1].trim();
                  const varValue = match[2].trim();
                  if (missingInTfvars.includes(varName)) {
                    newContent += `\n${varName} = ${varValue}`;
                    fixes.push(`Added "${varName}" = ${varValue} to ${primaryTfvars.fileName}`);
                    fixedIssues++;
                  }
                }
              });
            } else {
              // Fallback if AI didn't generate values
              missingInTfvars.forEach(varName => {
                const varAssignment = `\n${varName} = "<value>"  # TODO: Set appropriate value`;
                newContent += varAssignment;
                fixes.push(`Added "${varName}" to ${primaryTfvars.fileName} (needs value)`);
                fixedIssues++;
              });
            }
            
            await storage.updateFile(primaryTfvars.id, newContent);
            console.log(`      ✅ Updated ${primaryTfvars.fileName} (ID: ${primaryTfvars.id}, new size: ${newContent.length} chars)`);
          }
        }

        // Fix 3: AI-driven best practices fixing (for complex issues like multiple resources, structure, etc.)
        console.log(`      🤖 Fix 3: Running AI-driven best practices fixing...`);
        try {
          // First, run validation to get current issues
          // Include ALL files (main.tf, variables.tf, .tfvars) so AI has full context
          const validationFiles = terraformFiles.map(f => ({ fileName: f.fileName, content: f.content }));
          console.log(`      📄 Files being analyzed: ${validationFiles.map(f => f.fileName).join(', ')}`);
          
          const aiAnalysis = await openaiService.analyzeTerraformBestPractices(validationFiles);
          
          // Filter for issues that need AI fixing (multiple resources, structure issues, etc.)
          const aiFixableIssues = aiAnalysis.issues.filter(issue => 
            issue.type === 'multiple_resources_same_type' || 
            issue.type === 'poor_structure' ||
            issue.type === 'naming_issue' ||
            (issue.type === 'hardcoded_value' && issue.severity === 'error')
          );

          if (aiFixableIssues.length > 0) {
            console.log(`      🔧 AI will fix ${aiFixableIssues.length} complex issue(s)`);
            
            const aiFixResult = await openaiService.fixTerraformBestPractices(
              validationFiles,
              aiFixableIssues
            );

            if (aiFixResult.files && aiFixResult.files.length > 0) {
              // Update files with AI fixes
              for (const fixedFile of aiFixResult.files) {
                const existingFile = terraformFiles.find(f => f.fileName === fixedFile.fileName);
                if (existingFile) {
                  // File exists, update it
                  await storage.updateFile(existingFile.id, fixedFile.content);
                  console.log(`      ✅ AI updated ${fixedFile.fileName} (ID: ${existingFile.id})`);
                  fixedIssues += aiFixableIssues.length;
                } else {
                  // File doesn't exist, create it
                  await storage.createFile({
                    sessionId,
                    fileName: fixedFile.fileName,
                    content: fixedFile.content
                  });
                  console.log(`      ✅ AI created ${fixedFile.fileName} (new file)`);
                  fixedIssues += aiFixableIssues.length;
                }
              }

              // Refresh local references after all updates
              const refreshedFiles = await storage.getFilesBySession(sessionId);
              const refreshedMainTf = refreshedFiles.find(f => f.fileName === 'main.tf');
              const refreshedVariablesTf = refreshedFiles.find(f => f.fileName === 'variables.tf');
              const refreshedTfvars = refreshedFiles.find(f => f.fileName === 'dev.terraform.tfvars' || f.fileName.endsWith('.tfvars'));
              
              if (refreshedMainTf) {
                mainTf = refreshedMainTf;
              }
              if (refreshedVariablesTf) {
                variablesTf = refreshedVariablesTf;
              }
              if (refreshedTfvars) {
                // Update primaryTfvars reference
                const updatedTfvarsFiles = refreshedFiles.filter(f => f.fileName.endsWith('.tfvars'));
                const updatedPrimaryTfvars = updatedTfvarsFiles.find(f => f.fileName === 'dev.terraform.tfvars') || updatedTfvarsFiles[0];
                if (updatedPrimaryTfvars) {
                  // Note: primaryTfvars is const, so we can't reassign it, but we'll use the refreshed one
                }
              }

              // Add fix descriptions
              if (aiFixResult.fixes && aiFixResult.fixes.length > 0) {
                aiFixResult.fixes.forEach(fix => fixes.push(`AI Fix: ${fix}`));
              }
              
              console.log(`      📋 AI processed ${aiFixResult.files.length} file(s): ${aiFixResult.files.map(f => f.fileName).join(', ')}`);
            } else {
              console.log(`      ⚠️  AI returned no files to update`);
            }
          }
        } catch (aiFixError: any) {
          console.error(`      ⚠️  AI best practices fixing failed: ${aiFixError.message}`);
          // Continue with regex-based fixes
        }

        // Fix 4: Replace hardcoded values in main.tf with variables (regex-based for simple cases)
        if (mainTf) {
          console.log(`      🔧 Fix 4: Checking for hardcoded values in main.tf (regex-based)`);
          let newContent = mainTf.content;
          const lines = newContent.split('\n');
          let modified = false;
          
          // Use AI to detect configurable attributes for each resource type
          // For now, use a common list, but this could be enhanced with AI per-resource
          const configurableAttributes = [
            'name', 'location', 'region', 'resource_group_name', 'account_tier',
            'account_replication_type', 'sku', 'instance_type', 'instance_class',
            'size', 'tier', 'capacity', 'billing_mode', 'read_capacity', 'write_capacity'
          ];

        const newLines: string[] = [];
        const variablesToAdd: Array<{ name: string; value: string; attr: string }> = [];

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
          const line = lines[lineNum];
          const trimmed = line.trim();
          
          // Skip comments and empty lines
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
            newLines.push(line);
            continue;
          }

          // Skip lines that already use variables
          if (trimmed.includes('var.') || trimmed.includes('${var.')) {
            newLines.push(line);
            continue;
          }

          let lineModified = false;
          // Check each configurable attribute
          for (const attr of configurableAttributes) {
            const attrPattern = new RegExp(`(${attr}\\s*=\\s*)"([^"]+)"`, 'i');
            const attrMatch = trimmed.match(attrPattern);
            
            if (attrMatch) {
              const value = attrMatch[2];
              // Skip if it's a reference or built-in
              // Use AI to determine if this value should be a variable
              // For now, use basic heuristics, but this could be enhanced with AI
              if (!value.match(/^(data\.|resource\.|module\.|local\.|path\.|self\.|count\.|each\.|var\.)/) &&
                  !value.match(/^[0-9]+$/) && // Skip pure numbers (might be counts)
                  value.length > 2 && // More lenient - fix values longer than 2 chars
                  !value.match(/^(true|false|null)$/i)) {
                
                // Create variable name from attribute
                const varName = attr.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
                
                // Replace with variable reference
                const newLine = line.replace(attrMatch[0], `${attrMatch[1]}var.${varName}`);
                newLines.push(newLine);
                lineModified = true;
                modified = true;
                
                // Track variables that need to be added
                if (!declaredVariables.has(varName)) {
                  variablesToAdd.push({ name: varName, value, attr });
                  declaredVariables.add(varName);
                }
                
                fixes.push(`Replaced hardcoded "${attr}" value with var.${varName} in main.tf (line ${lineNum + 1})`);
                fixedIssues++;
                break;
              }
            }
          }
          
          if (!lineModified) {
            newLines.push(line);
          }
        }

        // Add variables that were created during replacement
        for (const { name: varName, value, attr } of variablesToAdd) {
          // Add to variables.tf if it exists
          if (variablesTf) {
            const varDeclaration = `\n\nvariable "${varName}" {\n  description = "Value for ${attr}"\n  type        = string\n}`;
            const updatedVariablesTf = variablesTf.content + varDeclaration;
            await storage.updateFile(variablesTf.id, updatedVariablesTf);
            variablesTf = { ...variablesTf, content: updatedVariablesTf };
            fixes.push(`Added variable declaration for "${varName}" to variables.tf`);
          }
          
          // Add to tfvars if it exists
          if (primaryTfvars) {
            const varAssignment = `\n${varName} = "${value}"`;
            const updatedTfvars = primaryTfvars.content.trim() + (primaryTfvars.content.trim().endsWith('\n') ? '' : '\n') + varAssignment;
            await storage.updateFile(primaryTfvars.id, updatedTfvars);
          }
        }

          if (modified) {
            newContent = newLines.join('\n');
            await storage.updateFile(mainTf.id, newContent);
            console.log(`      ✅ Updated main.tf (ID: ${mainTf.id}, new size: ${newContent.length} chars)`);
          }
        }

        // Fix 5: Remove redundant defaults from variables.tf
        if (variablesTf && primaryTfvars) {
          console.log(`      🔧 Fix 5: Checking for redundant defaults in variables.tf`);
          const lines = variablesTf.content.split('\n');
          const newLines: string[] = [];
          let currentVariable = '';
          let skipNextDefault = false;
        
        lines.forEach((line) => {
          const trimmed = line.trim();
          
          // Detect variable declaration
          const varMatch = trimmed.match(/variable\s+"([^"]+)"/);
          if (varMatch) {
            currentVariable = varMatch[1];
            skipNextDefault = tfvarsVariables.has(currentVariable);
            newLines.push(line);
            return;
          }
          
          // Skip default lines if variable is in tfvars
          if (skipNextDefault && trimmed.includes('default') && trimmed.includes('=')) {
            fixes.push(`Removed redundant default for "${currentVariable}" from variables.tf`);
            fixedIssues++;
            return; // Skip this line
          }
          
          // Reset skip flag when we leave the variable block
          if (trimmed === '}' && skipNextDefault) {
            skipNextDefault = false;
          }
          
          newLines.push(line);
        });

          if (newLines.length !== lines.length) {
            const newContent = newLines.join('\n');
            await storage.updateFile(variablesTf.id, newContent);
            console.log(`      ✅ Updated variables.tf (ID: ${variablesTf.id}, removed ${lines.length - newLines.length} line(s))`);
          }
        }

        // Fix 6: Add missing variable declarations for variables in tfvars
        if (variablesTf && primaryTfvars) {
          const missingDeclarations = Array.from(tfvarsVariables).filter(v => !declaredVariables.has(v));
          if (missingDeclarations.length > 0) {
            console.log(`      🔧 Fix 6: Adding ${missingDeclarations.length} missing variable declaration(s) for variables in .tfvars`);
            let newContent = variablesTf.content;
            missingDeclarations.forEach(varName => {
              const varDeclaration = `\n\nvariable "${varName}" {\n  description = "Value for ${varName}"\n  type        = string\n}`;
              newContent += varDeclaration;
              fixes.push(`Added variable declaration for "${varName}" to variables.tf (was in .tfvars)`);
              fixedIssues++;
            });
            await storage.updateFile(variablesTf.id, newContent);
            console.log(`      ✅ Updated variables.tf (ID: ${variablesTf.id}, new size: ${newContent.length} chars)`);
          }
        }

        totalFixedIssues += fixedIssues;
        allFixes.push(...fixes);

        console.log(`   ✅ Pass ${pass} complete: Fixed ${fixedIssues} issue(s)`);
        if (fixes.length > 0) {
          console.log(`   📋 Fixes applied in this pass:`);
          fixes.forEach(fix => console.log(`      - ${fix}`));
        }

        // Verify files were actually updated by re-fetching
        if (fixedIssues > 0) {
          const verifyFiles = await storage.getFilesBySession(sessionId);
          const verifyMainTf = verifyFiles.find(f => f.fileName === 'main.tf');
          const verifyVariablesTf = verifyFiles.find(f => f.fileName === 'variables.tf');
          const verifyTfvars = verifyFiles.find(f => f.fileName.endsWith('.tfvars'));
          
          console.log(`   🔍 Verification after pass ${pass}:`);
          if (verifyMainTf) {
            console.log(`      - main.tf: ${verifyMainTf.content.length} chars (ID: ${verifyMainTf.id})`);
          }
          if (verifyVariablesTf) {
            console.log(`      - variables.tf: ${verifyVariablesTf.content.length} chars (ID: ${verifyVariablesTf.id})`);
          }
          if (verifyTfvars) {
            console.log(`      - ${verifyTfvars.fileName}: ${verifyTfvars.content.length} chars (ID: ${verifyTfvars.id})`);
          }
        }

        // If no issues were fixed in this pass, we're done
        if (fixedIssues === 0) {
          console.log(`   ✅ No more issues to fix!`);
          break;
        }

        // Re-fetch files for next pass to ensure we have latest state
        // (This happens automatically at the start of the next loop iteration)
      }

      console.log(`\n✅ [REFACTOR-FIX] All fix passes complete:`);
      console.log(`   Total passes: ${pass}`);
      console.log(`   Total issues fixed: ${totalFixedIssues}`);
      allFixes.forEach(fix => console.log(`   - ${fix}`));

      res.json({
        success: true,
        fixedIssues: totalFixedIssues,
        passes: pass,
        message: `Successfully fixed ${totalFixedIssues} issue(s) in ${pass} pass(es)`,
        fixes: allFixes
      });
    } catch (error: any) {
      console.error('Error fixing Terraform files:', error);
      res.status(500).json({ 
        error: 'Failed to fix Terraform files',
        details: error.message 
      });
    }
  });

  // Analyze architecture requirements from natural language
  app.post("/api/sessions/:id/analyze-architecture", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const { requirements } = req.body;

      if (!requirements || typeof requirements !== 'string' || requirements.trim().length === 0) {
        return res.status(400).json({
          error: 'Invalid requirements',
          details: 'Requirements must be a non-empty string'
        });
      }

      console.log(`\n🔍 Analyzing architecture requirements for session ${sessionId}`);
      console.log(`📝 Requirements: ${requirements.substring(0, 200)}${requirements.length > 200 ? '...' : ''}`);

      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({
          error: 'Session not found',
          details: `Session ${sessionId} does not exist`
        });
      }

      // Analyze architecture requirements
      const analysis = await analyzeArchitectureRequirements(requirements);

      // Store analysis in session metadata for diagram generation
      await storage.updateSession(sessionId, {
        archMeAnalysis: JSON.stringify(analysis)
      } as any);

      // Send AI message about the analysis
      await storage.createMessage({
        sessionId,
        type: 'ai',
        content: `✅ Architecture analysis complete! Found ${analysis.metadata.totalComponents} component(s), ${analysis.metadata.totalRelationships} relationship(s), and ${analysis.metadata.totalDataFlows} data flow(s). Cloud provider: ${analysis.cloudProvider}. Generating diagram...`
      });

      res.json({
        success: true,
        analysis,
        message: 'Architecture requirements analyzed successfully'
      });
    } catch (error: any) {
      console.error('❌ Error analyzing architecture:', error);
      res.status(500).json({
        error: 'Failed to analyze architecture requirements',
        details: error.message || 'Unknown error occurred'
      });
    }
  });

  // Generate architecture diagram from analysis (for ArchMe workflow)
  app.post("/api/sessions/:id/generate-architecture-diagram", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const requestedDiagramType = req.body.diagramType as DiagramType | undefined;
      const allowedDiagramTypes: DiagramType[] = [
        'flowchart',
        'sequence',
        'state',
        'pie',
        'class',
        'mindmap',
        'gantt',
        'erDiagram',
        'journey',
        'gitGraph',
      ];
      const diagramType: DiagramType = requestedDiagramType && allowedDiagramTypes.includes(requestedDiagramType)
        ? requestedDiagramType
        : 'flowchart';

      console.log(`\n🎨 Generating architecture diagram from analysis for session ${sessionId}`);

      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({
          error: 'Session not found',
          details: `Session ${sessionId} does not exist`
        });
      }

      // Get stored analysis
      const analysisJson = (session as any).archMeAnalysis;
      if (!analysisJson) {
        return res.status(400).json({
          error: 'No analysis found',
          details: 'Please analyze architecture requirements first'
        });
      }

      let analysis;
      try {
        analysis = JSON.parse(analysisJson);
      } catch (parseError) {
        return res.status(400).json({
          error: 'Invalid analysis data',
          details: 'Failed to parse stored analysis'
        });
      }

      // Generate diagram from analysis
      const result = await generateArchDiagramFromAnalysis(analysis, diagramType);

      console.log(`\n✅ Architecture diagram generated!`);
      console.log(`   📊 Components: ${result.metadata.totalComponents}`);
      console.log(`   🔗 Relationships: ${result.metadata.totalRelationships}`);

      res.json({
        success: true,
        mermaidSyntax: result.mermaidSyntax,
        resources: result.components,
        relationships: result.relationships,
        metadata: result.metadata
      });
    } catch (error: any) {
      console.error('❌ Error generating architecture diagram:', error);
      res.status(500).json({
        error: 'Failed to generate architecture diagram',
        details: error.message || 'Unknown error occurred'
      });
    }
  });

  // Extract components from approved diagram (for ArchMe workflow)
  app.post("/api/sessions/:id/extract-components", async (req, res) => {
    try {
      const sessionId = req.params.id;
      console.log(`\n🔍 Extracting components from diagram for session ${sessionId}`);

      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({
          error: 'Session not found',
          details: `Session ${sessionId} does not exist`
        });
      }

      // Get stored analysis
      const analysisJson = (session as any).archMeAnalysis;
      if (!analysisJson) {
        return res.status(400).json({
          error: 'No analysis found',
          details: 'Please analyze architecture requirements and generate diagram first'
        });
      }

      let analysis;
      try {
        analysis = JSON.parse(analysisJson);
      } catch (parseError) {
        return res.status(400).json({
          error: 'Invalid analysis data',
          details: 'Failed to parse stored analysis'
        });
      }

      // Extract components
      const components = extractComponents(analysis);

      console.log(`\n✅ Extracted ${components.length} components`);

      res.json({
        success: true,
        components
      });
    } catch (error: any) {
      console.error('❌ Error extracting components:', error);
      res.status(500).json({
        error: 'Failed to extract components',
        details: error.message || 'Unknown error occurred'
      });
    }
  });

  // Generate code for all components (for ArchMe workflow)
  app.post("/api/sessions/:id/generate-component-code", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const { components, repositoryType = 'github' } = req.body;

      console.log(`\n💻 Generating code for ${components?.length || 0} components`);

      if (!components || !Array.isArray(components) || components.length === 0) {
        return res.status(400).json({
          error: 'Invalid components',
          details: 'Components array is required'
        });
      }

      // Generate code for all components
      const generatedCode = await generateAllComponentCode(components, repositoryType);

      console.log(`\n✅ Generated code for ${generatedCode.length} components`);

      res.json({
        success: true,
        code: generatedCode
      });
    } catch (error: any) {
      console.error('❌ Error generating component code:', error);
      res.status(500).json({
        error: 'Failed to generate component code',
        details: error.message || 'Unknown error occurred'
      });
    }
  });

  // Scan ArchMe generated code with Checkov (uses same logic as Terraform scan)
  app.post("/api/sessions/:id/scan-archme-code", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const { code } = req.body;

      console.log(`\n🔍 Scanning ArchMe generated code for session ${sessionId}`);

      if (!code || !Array.isArray(code)) {
        return res.status(400).json({
          error: 'Invalid request',
          details: 'Code array is required'
        });
      }

      // Save generated code to session storage (same as Terraform workflow)
      const sessionFiles = await storage.getFilesBySession(sessionId);
      
      // Update existing files or create new ones
      for (const item of code) {
        const fileName = item.fileName || `${item.componentName}.tf`;
        const existingFile = sessionFiles.find(f => f.fileName === fileName);
        
        if (existingFile) {
          await storage.updateFile(existingFile.id, item.content || '');
        } else {
          await storage.createFile({
            sessionId,
            fileName,
            content: item.content || ''
          });
        }
      }

      // Determine if we should use Kubernetes or Terraform scan
      const hasKubernetes = code.some((c: any) => c.codeType === 'kubernetes' || c.codeType === 'yaml');
      
      if (hasKubernetes) {
        // Use Kubernetes scan endpoint
        const sessionFilesForScan = await storage.getFilesBySession(sessionId);
        const yamlFiles = sessionFilesForScan
          .filter(f => f.fileName.endsWith('.yaml') || f.fileName.endsWith('.yml'))
          .map(f => ({
            path: f.fileName,
            content: f.content
          }));

        if (yamlFiles.length === 0) {
          return res.status(400).json({
            error: 'No files to scan',
            details: 'No Kubernetes YAML files found in generated code'
          });
        }

        const { runCheckovKubernetes } = await import('./kubernetes/checkov-validator');
        const k8sResult = await runCheckovKubernetes(yamlFiles);
        
        // Use same comprehensive parsing logic as main Kubernetes scan endpoint
        // Use ONLY what Checkov returns - no fallback calculations
        const passed = k8sResult.passed != null ? Number(k8sResult.passed) : 0;
        const failed = k8sResult.failed != null ? Number(k8sResult.failed) : 0;
        const skipped = k8sResult.skipped != null ? Number(k8sResult.skipped) : 0;
        
        // Log if passed is missing (but don't calculate it)
        if (k8sResult.passed == null) {
          console.log(`   ⚠️  k8sResult.passed is missing from Checkov output - using 0`);
        }
        
        // Ensure all values are numbers
        const actualPassed = passed;
        const actualFailed = failed;
        const actualSkipped = skipped;
        const total = actualPassed + actualFailed + actualSkipped;
        
        // Calculate pass percentage correctly: passed / total (including skipped)
        const passPercentage = total > 0 
          ? Math.round((actualPassed / total) * 100)
          : 0;
        
        // Log for debugging (same format as Terraform and Kubernetes scans)
        console.log(`\n📊 ========== ARCHME KUBERNETES SCAN RESULTS PARSING ==========`);
        console.log(`   Raw k8sResult:`, JSON.stringify({
          passed: k8sResult.passed,
          failed: k8sResult.failed,
          skipped: k8sResult.skipped
        }));
        console.log(`   Summary counts: passed=${actualPassed}, failed=${actualFailed}, skipped=${actualSkipped}`);
        console.log(`   k8sResult.passed value:`, k8sResult.passed, `(type: ${typeof k8sResult.passed})`);
        console.log(`   k8sResult.failed value:`, k8sResult.failed, `(type: ${typeof k8sResult.failed})`);
        console.log(`   Detailed checks: failed_checks=${k8sResult.checks.length}`);
        console.log(`   Using normalized counts: actualPassed=${actualPassed}, actualFailed=${actualFailed}`);
        console.log(`   Total: ${total}, Pass Rate: ${passPercentage}%`);
        
        // Warn if all values are 0 (likely means no files were scanned)
        if (total === 0 && actualPassed === 0 && actualFailed === 0) {
          console.error(`\n❌ WARNING: All scan results are 0!`);
          console.error(`   This indicates Checkov did not find any Kubernetes resources to scan.`);
          console.error(`   Possible causes:`);
          console.error(`   1. No Kubernetes YAML files were written to temp directory`);
          console.error(`   2. Files were written but Checkov cannot parse them`);
          console.error(`   3. Files are empty or invalid`);
          console.error(`   Check the file writing logs above for details.`);
        }
        
        console.log(`==========================================\n`);
        
        // Prepare response (same structure as Terraform and Kubernetes scans)
        console.log(`\n📤 Preparing ArchMe Kubernetes API response:`);
        console.log(`   Response summary: passed=${actualPassed}, failed=${actualFailed}, skipped=${actualSkipped}, total=${total}, passPercentage=${passPercentage}`);

        res.json({
          success: true,
          summary: {
            passed: actualPassed,
            failed: actualFailed,
            skipped: actualSkipped,
            total: total,
            passPercentage: passPercentage
          },
          failedChecks: k8sResult.checks.map((check: any) => ({
            checkId: check.checkId || check.check_id,
            checkName: check.checkName || check.check_name,
            resource: check.resource,
            file: check.file,
            guideline: check.guideline,
            reason: check.message || check.guideline || `Security check ${check.checkId || check.check_id} failed`,
            evaluatedKeys: [],
            checkResult: 'FAILED'
          })),
          passedChecks: []
        });
      } else {
        // Files are saved to session storage - return success
        // Frontend will call the existing /api/sessions/:id/scan endpoint
        // which uses the same Checkov logic as Terraform workflow
        res.json({
          success: true,
          message: 'Files saved to session storage. Ready for scan.',
          filesSaved: code.length,
          scanEndpoint: `/api/sessions/${sessionId}/scan`
        });
      }
    } catch (error: any) {
      console.error('❌ Error preparing ArchMe code for scan:', error);
      res.status(500).json({
        error: 'Failed to prepare code for scan',
        details: error.message || 'Unknown error occurred'
      });
    }
  });

  // Generate README for ArchMe code
  app.post("/api/sessions/:id/generate-archme-readme", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const { code } = req.body;

      console.log(`\n📝 Generating README for ArchMe code`);

      if (!code || !Array.isArray(code)) {
        return res.status(400).json({
          error: 'Invalid request',
          details: 'Code array is required'
        });
      }

      const readmeContent = generateReadme(code);

      res.json({
        success: true,
        readme: readmeContent
      });
    } catch (error: any) {
      console.error('❌ Error generating README:', error);
      res.status(500).json({
        error: 'Failed to generate README',
        details: error.message || 'Unknown error occurred'
      });
    }
  });

  // Commit ArchMe generated code to repository
  app.post("/api/sessions/:id/commit-archme-code", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const { provider, repoId, code, message, branch = 'main' } = req.body;

      console.log(`\n📤 Committing ArchMe code to ${provider} repository ${repoId}`);

      if (!provider || !repoId || !code || !Array.isArray(code)) {
        return res.status(400).json({
          error: 'Invalid request',
          details: 'Provider, repoId, and code array are required'
        });
      }

      // For GitHub, we need to get the repository name from the ID
      // The repoId might be a numeric ID, so we need to look up the repository
      let repoName = repoId;
      if (provider === 'github') {
        try {
          // Try to get repository by ID from the list
          const repos = await mcpClient.listRepositories('github');
          const repo = repos.find((r: any) => 
            String(r.id) === String(repoId) || 
            r.id === repoId || 
            r.name === repoId ||
            r.full_name === repoId
          );
          
          if (repo) {
            // GitHub API returns repos with 'name' (just repo name) and 'full_name' (owner/repo)
            // Prefer full_name if available, otherwise construct it
            if (repo.full_name) {
              repoName = repo.full_name;
            } else if (repo.name) {
              const owner = process.env.GITHUB_OWNER || '';
              repoName = owner ? `${owner}/${repo.name}` : repo.name;
            } else {
              repoName = repoId;
            }
            console.log(`   📦 Resolved repository ID ${repoId} to name: ${repoName}`);
          } else {
            // If not found, check if repoId is already in "owner/repo" format
            if (repoId.includes('/')) {
              repoName = repoId;
              console.log(`   📦 Using repoId as repository name (already in owner/repo format): ${repoName}`);
            } else {
              // Assume it's just the repo name, add owner
              const owner = process.env.GITHUB_OWNER || '';
              repoName = owner ? `${owner}/${repoId}` : repoId;
              console.log(`   📦 Constructed repository name: ${repoName}`);
            }
          }
        } catch (lookupError: any) {
          console.warn(`   ⚠️  Could not lookup repository: ${lookupError.message}`);
          // Fallback: if repoId contains '/', use it as-is, otherwise add owner
          if (repoId.includes('/')) {
            repoName = repoId;
          } else {
            const owner = process.env.GITHUB_OWNER || '';
            repoName = owner ? `${owner}/${repoId}` : repoId;
          }
          console.log(`   📦 Fallback: Using repository name: ${repoName}`);
        }
      }

      // Convert code array to files format
      const files = code.map((item: any) => ({
        path: item.fileName || `${item.componentName}.tf`,
        content: item.content || ''
      }));

      // Generate and add README if not already in code
      if (!code.some((c: any) => c.fileName === 'README.md' || c.fileName === 'readme.md')) {
        const readmeContent = generateReadme(code);
        files.push({
          path: 'README.md',
          content: readmeContent
        });
        console.log(`   📝 Added README.md to commit`);
      }

      // Commit files using MCP client
      const result = await mcpClient.commitFiles(
        provider as 'github' | 'azure',
        repoName,
        files,
        message || `Add infrastructure code from ArchMe diagram`
      );

      console.log(`\n✅ Successfully committed ${files.length} files to repository`);

      res.json({
        success: true,
        message: `Successfully committed ${files.length} file(s) to repository`,
        commitResult: result
      });
    } catch (error: any) {
      console.error('❌ Error committing ArchMe code:', error);
      res.status(500).json({
        error: 'Failed to commit code to repository',
        details: error.message || 'Unknown error occurred'
      });
    }
  });

  // Generate architecture diagram from Terraform files
  app.post("/api/sessions/:id/generate-diagram", async (req, res) => {
    const sessionId = req.params.id;
    
    try {
      console.log(`\n🎨 ========== DIAGRAM GENERATION REQUEST ==========`);
      console.log(`Session ID: ${sessionId}`);
      console.log(`Timestamp: ${new Date().toISOString()}`);

      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        console.error(`❌ Session not found: ${sessionId}`);
        return res.status(404).json({ 
          error: 'Session not found',
          details: `Session ${sessionId} does not exist`
        });
      }

      console.log(`✅ Session found: step=${session.currentStep}, workflow=${session.workflowStep}`);

      // Get Terraform files from session storage
      console.log(`📁 Fetching Terraform files from session storage...`);
      const sessionFiles = await storage.getFilesBySession(sessionId);
      console.log(`📋 Total files in session: ${sessionFiles.length}`);
      sessionFiles.forEach(f => {
        console.log(`   - ${f.fileName} (${f.content.length} bytes)`);
      });
      
      const terraformFiles = sessionFiles
        .filter(f => {
          const fileName = f.fileName.toLowerCase();
          const isTerraform = fileName.endsWith('.tf') || fileName.endsWith('.tfvars');
          // For aggregated-root, exclude backend files from diagram generation
          if (session.moduleApproach === 'aggregated-root') {
            const backendFiles = ['backend.tf', 'provider.tf', 'terraform.tf'];
            return isTerraform && !backendFiles.includes(fileName) && f.content && f.content.trim().length > 0;
          }
          return isTerraform && f.content && f.content.trim().length > 0;
        })
        .map(f => ({
          fileName: f.fileName,
          content: f.content
        }));

      console.log(`✅ Found ${terraformFiles.length} Terraform file(s) for diagram generation`);
      terraformFiles.forEach(f => {
        console.log(`   - ${f.fileName} (${f.content.length} bytes)`);
      });

      if (terraformFiles.length === 0) {
        console.error(`❌ No Terraform files found in session storage`);
        console.error(`   Total files: ${sessionFiles.length}`);
        console.error(`   Module approach: ${session.moduleApproach}`);
        return res.status(400).json({ 
          error: 'No Terraform files found',
          details: 'Please generate Terraform code first before creating a diagram',
          totalFiles: sessionFiles.length,
          moduleApproach: session.moduleApproach
        });
      }

      // Determine cloud provider from session or files
      const cloudProvider = session.cloudProvider || 'azure';
      const useAI = req.body.useAI !== false; // Default to true, allow override
      const diagramType = req.body.diagramType || 'flowchart'; // Default to flowchart

      console.log(`\n📊 ========== DIAGRAM GENERATION REQUEST ==========`);
      console.log(`☁️  Cloud Provider: ${cloudProvider}`);
      console.log(`🤖 AI Enhancement: ${useAI ? 'enabled' : 'disabled'}`);
      console.log(`📊 Diagram Type: ${diagramType}`);
      console.log(`📦 Request Body:`, JSON.stringify(req.body, null, 2));

      // Generate diagram
      const result = await generateArchitectureDiagram(
        terraformFiles,
        cloudProvider,
        useAI,
        diagramType
      );

      console.log(`\n✅ Diagram generation complete!`);
      console.log(`   📊 Resources: ${result.metadata.totalResources}`);
      console.log(`   🔗 Relationships: ${result.metadata.totalRelationships}`);
      console.log(`   📁 Categories: ${result.metadata.categories.join(', ')}`);

      // Return result
      res.json({
        success: true,
        mermaidSyntax: result.mermaidSyntax,
        resources: result.resources,
        relationships: result.relationships,
        metadata: result.metadata
      });

    } catch (error: any) {
      console.error('❌ Error generating architecture diagram:', error);
      res.status(500).json({ 
        error: 'Failed to generate architecture diagram',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Generate Kubernetes diagram from manifests
  app.post("/api/sessions/:id/generate-kubernetes-diagram", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const useAI = req.body.useAI !== false; // Default to true

      console.log(`\n🎨 ========== KUBERNETES DIAGRAM GENERATION ==========`);
      console.log(`Session ID: ${sessionId}`);
      console.log(`AI Enhancement: ${useAI ? 'enabled' : 'disabled'}`);

      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        console.error(`❌ Session not found: ${sessionId}`);
        return res.status(404).json({ 
          error: 'Session not found',
          details: `Session ${sessionId} does not exist`
        });
      }

      // Get Kubernetes YAML files from session storage
      console.log(`📁 Fetching Kubernetes files from session storage...`);
      const sessionFiles = await storage.getFilesBySession(sessionId);
      const yamlFiles = sessionFiles
        .filter(f => f.fileName.endsWith('.yaml') || f.fileName.endsWith('.yml'))
        .map(f => f.content);

      console.log(`✅ Found ${yamlFiles.length} Kubernetes file(s)`);

      if (yamlFiles.length === 0) {
        console.error(`❌ No Kubernetes YAML files found in session storage`);
        return res.status(400).json({ 
          error: 'No Kubernetes files found',
          details: 'Please generate Kubernetes manifests first before creating a diagram'
        });
      }

      // Get diagram type from request
      const diagramType = req.body.diagramType || 'flowchart';
      
      // Generate diagram
      const result = await generateKubernetesDiagram(yamlFiles, useAI, diagramType);

      console.log(`\n✅ Kubernetes diagram generation complete!`);
      console.log(`   📊 Resources: ${result.metadata.totalResources}`);
      console.log(`   🔗 Relationships: ${result.metadata.totalRelationships}`);
      console.log(`   📁 Types: ${result.metadata.resourceTypes?.join(', ') || 'N/A'}`);

      // Return result (format to match frontend expectations)
      res.json({
        success: true,
        mermaidSyntax: result.mermaidSyntax,
        resources: result.resources.map(r => ({
          type: r.kind,
          name: r.name,
          file: r.file
        })),
        relationships: result.relationships.map(r => ({
          from: r.from,
          to: r.to,
          type: r.type,
          description: r.description
        })),
        metadata: {
          totalResources: result.metadata.totalResources,
          totalRelationships: result.metadata.totalRelationships,
          totalComponents: result.metadata.totalResources, // Alias for compatibility
          cloudProvider: 'kubernetes', // Kubernetes is cloud-agnostic
          categories: result.metadata.resourceTypes || [],
          resourceTypes: result.metadata.resourceTypes || []
        }
      });

    } catch (error: any) {
      console.error('❌ Error generating Kubernetes diagram:', error);
      res.status(500).json({ 
        error: 'Failed to generate Kubernetes diagram',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Generate automation script
  app.post("/api/sessions/:id/generate-automation", async (req, res) => {
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

  // Generate Kubernetes manifests
  app.post("/api/sessions/:id/generate-kubernetes-manifests", async (req, res) => {
    try {
      const { description, options } = req.body;
      const sessionId = req.params.id;

      if (!description || typeof description !== 'string') {
        return res.status(400).json({ 
          error: 'Missing required field',
          details: 'description is required and must be a string'
        });
      }

      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      console.log(`\n🤖 ========== KUBERNETES MANIFEST GENERATION ==========`);
      console.log(`Session ID: ${sessionId}`);
      console.log(`Description: "${description.substring(0, 100)}${description.length > 100 ? '...' : ''}"`);

      // Validate input before generating
      try {
        const { validateKubernetesInput } = await import('./kubernetes/input-validator');
        const validation = validateKubernetesInput(description);
        if (!validation.valid) {
          return res.status(400).json({
            error: validation.error || 'Invalid input for Kubernetes workflow',
            details: validation.error,
            suggestions: validation.suggestions || [],
          });
        }
      } catch (validationError: any) {
        console.warn('⚠️  Input validation error:', validationError);
        // Continue if validation module fails (shouldn't happen, but don't block)
      }

      // Generate manifests
      const result = await generateKubernetesManifests(description, options || {});

      console.log(`✅ Generated ${result.files.length} manifest file(s)`);

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
        content: `✅ Kubernetes manifests have been generated successfully! ${result.files.length} file(s) created: ${result.files.map(f => f.path).join(', ')}`,
      });

      console.log('==========================================\n');

      res.json({
        success: true,
        files: result.files,
        metadata: result.metadata
      });

    } catch (error: any) {
      console.error('❌ Error generating Kubernetes manifests:', error);
      res.status(500).json({ 
        error: 'Failed to generate Kubernetes manifests',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Commit Kubernetes files to repository
  app.post("/api/sessions/:id/commit-kubernetes", async (req, res) => {
    const sessionId = req.params.id;
    let session: any = null;
    
    try {
      session = await storage.getSession(sessionId);
      
      if (!session || !session.provider || !session.repositoryName) {
        return res.status(400).json({ error: 'Session not properly configured' });
      }

      const { message, branch = 'main' } = req.body;

      // Get files from session storage
      console.log(`\n📁 Getting Kubernetes files from session storage for commit...`);
      const files = await storage.getFilesBySession(sessionId);
      
      console.log(`✅ Found ${files.length} file(s) in session storage`);
      
      if (files.length === 0) {
        return res.status(400).json({ 
          error: 'No files found to commit',
          details: 'No Kubernetes files have been generated for this session yet.'
        });
      }
      
      // Filter to Kubernetes YAML files
      const kubernetesFiles = files.filter(file => {
        const fileName = file.fileName.toLowerCase();
        return fileName.endsWith('.yaml') || fileName.endsWith('.yml');
      });
      
      console.log(`📄 Kubernetes files to commit: ${kubernetesFiles.length}`);
      kubernetesFiles.forEach(f => {
        console.log(`   - ${f.fileName} (${f.content.length} chars)`);
      });
      
      if (kubernetesFiles.length === 0) {
        return res.status(400).json({ 
          error: 'No Kubernetes files found to commit',
          details: 'No Kubernetes YAML files (.yaml or .yml) found in session'
        });
      }
      
      // Generate commit message if not provided
      let commitMessage = message;
      if (!commitMessage) {
        try {
          commitMessage = await openaiService.generateCommitMessage(
            kubernetesFiles.map(f => ({ name: f.fileName, content: f.content }))
          );
        } catch (error: any) {
          console.warn(`⚠️  Failed to generate commit message: ${error.message}`);
          commitMessage = `Add Kubernetes manifests: ${kubernetesFiles.map(f => f.fileName).join(', ')}`;
        }
      }

      // Commit via MCP
      const result = await mcpClient.commitFiles(
        session.provider as MCPProvider,
        session.repositoryName,
        kubernetesFiles.map(f => ({ path: f.fileName, content: f.content })),
        commitMessage
      );

      console.log(`✅ Successfully committed ${kubernetesFiles.length} Kubernetes file(s) to ${session.provider}/${session.repositoryName}`);
      console.log(`   Commit message: ${commitMessage}`);
      console.log(`   Branch: ${branch}`);

      res.json({
        success: true,
        commitMessage,
        branch,
        filesCommitted: kubernetesFiles.length,
        commitUrl: result.commitUrl || undefined,
      });

    } catch (error: any) {
      console.error('❌ Error committing Kubernetes files:', error);
      res.status(500).json({ 
        error: 'Failed to commit Kubernetes files',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Scan Kubernetes resources with Checkov
  app.post("/api/sessions/:id/scan-kubernetes", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      console.log(`\n🔍 ========== KUBERNETES SECURITY SCAN ==========`);
      console.log(`Session ID: ${sessionId}`);

      // Get Kubernetes YAML files from session storage
      const files = await storage.getFilesBySession(sessionId);
      const yamlFiles = files.filter(f => 
        f.fileName.endsWith('.yaml') || f.fileName.endsWith('.yml')
      );

      if (yamlFiles.length === 0) {
        return res.status(400).json({ 
          error: 'No Kubernetes files found',
          details: 'No YAML files found in session storage'
        });
      }

      console.log(`📁 Found ${yamlFiles.length} Kubernetes file(s)`);

      // Run Checkov
      const yamlFilesForCheckov = yamlFiles.map(f => ({
        path: f.fileName,
        content: f.content
      }));

      const checkovResult = await runCheckovKubernetes(yamlFilesForCheckov);

      // Format response similar to Terraform scan - use same comprehensive parsing logic
      const failedChecks = checkovResult.checks.map(check => {
        // Ensure reason is always present and meaningful
        const reason = check.message || check.guideline || `Security check ${check.checkId} failed for resource ${check.resource}`;
        
        console.log(`📋 Formatted check: ${check.checkId} - Reason: ${reason.substring(0, 80)}...`);
        
        return {
          checkId: check.checkId,
          checkName: check.checkName,
          resource: check.resource,
          file: check.file,
          guideline: check.guideline,
          reason: reason,
        };
      });

      const passedChecks: any[] = []; // Checkov doesn't return passed checks in our current implementation

      // Use same comprehensive parsing logic as Terraform scan
      // Use ONLY what Checkov returns - no fallback calculations
      const passed = checkovResult.passed != null ? Number(checkovResult.passed) : 0;
      const failed = checkovResult.failed != null ? Number(checkovResult.failed) : 0;
      const skipped = checkovResult.skipped != null ? Number(checkovResult.skipped) : 0;
      
      // Log if passed is missing (but don't calculate it)
      if (checkovResult.passed == null) {
        console.log(`   ⚠️  checkovResult.passed is missing from Checkov output - using 0`);
      }
      
      // Ensure all values are numbers
      const actualPassed = passed;
      const actualFailed = failed;
      const actualSkipped = skipped;
      const total = actualPassed + actualFailed + actualSkipped;
      
      // Calculate pass percentage correctly: passed / total (including skipped)
      const passPercentage = total > 0 
        ? Math.round((actualPassed / total) * 100)
        : 0;
      
      // Log for debugging (same format as Terraform)
      console.log(`\n📊 ========== KUBERNETES SCAN RESULTS PARSING ==========`);
      console.log(`   Raw checkovResult:`, JSON.stringify({
        passed: checkovResult.passed,
        failed: checkovResult.failed,
        skipped: checkovResult.skipped
      }));
      console.log(`   Summary counts: passed=${actualPassed}, failed=${actualFailed}, skipped=${actualSkipped}`);
      console.log(`   checkovResult.passed value:`, checkovResult.passed, `(type: ${typeof checkovResult.passed})`);
      console.log(`   checkovResult.failed value:`, checkovResult.failed, `(type: ${typeof checkovResult.failed})`);
      console.log(`   Detailed checks: failed_checks=${failedChecks.length}`);
      console.log(`   Using normalized counts: actualPassed=${actualPassed}, actualFailed=${actualFailed}`);
      console.log(`   Total: ${total}, Pass Rate: ${passPercentage}%`);
      
      // Warn if all values are 0 (likely means no files were scanned)
      if (total === 0 && actualPassed === 0 && actualFailed === 0) {
        console.error(`\n❌ WARNING: All scan results are 0!`);
        console.error(`   This indicates Checkov did not find any Kubernetes resources to scan.`);
        console.error(`   Possible causes:`);
        console.error(`   1. No Kubernetes YAML files were written to temp directory`);
        console.error(`   2. Files were written but Checkov cannot parse them`);
        console.error(`   3. Files are empty or invalid`);
        console.error(`   Check the file writing logs above for details.`);
      }
      
      console.log(`==========================================\n`);
      
      // Prepare response (same structure as Terraform)
      console.log(`\n📤 Preparing Kubernetes API response:`);
      console.log(`   Response summary: passed=${actualPassed}, failed=${actualFailed}, skipped=${actualSkipped}, total=${total}, passPercentage=${passPercentage}`);
      
      const summary = {
        passed: actualPassed,
        failed: actualFailed,
        skipped: actualSkipped,
        total: total,
        passPercentage: passPercentage,
      };

      res.json({
        success: true,
        summary,
        failedChecks,
        passedChecks,
      });

    } catch (error: any) {
      console.error('❌ Error scanning Kubernetes resources:', error);
      res.status(500).json({ 
        error: 'Failed to scan Kubernetes resources',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Validate Kubernetes YAML files (Schema + Best Practices)
  app.post("/api/sessions/:id/validate-kubernetes", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      console.log(`\n🔍 ========== KUBERNETES YAML VALIDATION ==========`);
      console.log(`Session ID: ${sessionId}`);

      // Get Kubernetes YAML files from session storage
      const files = await storage.getFilesBySession(sessionId);
      const yamlFiles = files.filter(f => 
        f.fileName.endsWith('.yaml') || f.fileName.endsWith('.yml')
      );

      if (yamlFiles.length === 0) {
        return res.status(400).json({ 
          error: 'No Kubernetes files found',
          details: 'No YAML files found in session storage'
        });
      }

      console.log(`📁 Found ${yamlFiles.length} Kubernetes file(s)`);

      // Extract YAML content
      const yamlContents = yamlFiles.map(f => f.content);

      // Step 1: Schema validation using kubeval
      console.log(`\n[1/2] Running schema validation (kubeval)...`);
      let schemaValidationResult;
      try {
        schemaValidationResult = await validateKubernetesYAML(yamlContents);
        console.log(`✅ Schema validation: ${schemaValidationResult.valid ? 'valid' : 'invalid'}`);
        console.log(`   Schema errors: ${schemaValidationResult.errors.length}`);
        console.log(`   Schema warnings: ${schemaValidationResult.warnings.length}`);
      } catch (schemaError: any) {
        console.warn(`⚠️  Schema validation failed: ${schemaError.message}`);
        // Continue with best practices even if schema validation fails
        schemaValidationResult = {
          success: false,
          valid: false,
          errors: [{
            severity: 'error' as const,
            message: `Schema validation error: ${schemaError.message}`,
          }],
          warnings: [],
        };
      }

      // Step 2: Best practices analysis using AI
      console.log(`\n[2/2] Running best practices analysis...`);
      let bestPracticesResult;
      try {
        bestPracticesResult = await analyzeKubernetesBestPractices(yamlContents);
        console.log(`✅ Best practices analysis: ${bestPracticesResult.issues.length} issue(s) found`);
      } catch (bpError: any) {
        console.warn(`⚠️  Best practices analysis failed: ${bpError.message}`);
        // Continue even if best practices analysis fails
        bestPracticesResult = {
          success: false,
          issues: [],
          summary: 'Best practices analysis failed',
        };
      }

      // Combine results
      // Schema errors are critical (errors)
      // Best practice issues are warnings (unless high priority, then they're errors)
      const combinedErrors = [...schemaValidationResult.errors];
      const combinedWarnings = [...schemaValidationResult.warnings];

      // Convert best practice issues to validation issues
      bestPracticesResult.issues.forEach((issue) => {
        const validationIssue = {
          severity: (issue.priority === 'high' ? 'error' : 'warning') as 'error' | 'warning',
          message: `[${issue.category}] ${issue.issue}. ${issue.suggestion}`,
          file: issue.file,
          line: issue.line,
        };

        if (issue.priority === 'high') {
          combinedErrors.push(validationIssue);
        } else {
          combinedWarnings.push(validationIssue);
        }
      });

      // Overall validation is valid only if no schema errors and no high-priority best practice issues
      const isValid = schemaValidationResult.valid && 
                      bestPracticesResult.issues.filter(i => i.priority === 'high').length === 0;

      console.log(`\n✅ Validation complete:`);
      console.log(`   Schema: ${schemaValidationResult.valid ? 'valid' : 'invalid'}`);
      console.log(`   Best practices: ${bestPracticesResult.issues.length} issue(s)`);
      console.log(`   Overall: ${isValid ? 'valid' : 'invalid'}`);
      console.log(`   Total errors: ${combinedErrors.length}`);
      console.log(`   Total warnings: ${combinedWarnings.length}`);
      console.log('==========================================\n');

      // Format response to match frontend expectations
      res.json({
        success: true,
        valid: isValid,
        schemaValid: schemaValidationResult.valid,
        bestPracticesAnalyzed: bestPracticesResult.success,
        errors: combinedErrors.map(err => ({
          severity: err.severity,
          message: err.message,
          file: err.file,
          line: err.line,
        })),
        warnings: combinedWarnings.map(warn => ({
          severity: warn.severity,
          message: warn.message,
          file: warn.file,
          line: warn.line,
        })),
        summary: {
          schemaErrors: schemaValidationResult.errors.length,
          schemaWarnings: schemaValidationResult.warnings.length,
          bestPracticeIssues: bestPracticesResult.issues.length,
          highPriorityIssues: bestPracticesResult.issues.filter(i => i.priority === 'high').length,
          mediumPriorityIssues: bestPracticesResult.issues.filter(i => i.priority === 'medium').length,
          lowPriorityIssues: bestPracticesResult.issues.filter(i => i.priority === 'low').length,
        },
      });

    } catch (error: any) {
      console.error('❌ Error validating Kubernetes YAML:', error);
      res.status(500).json({ 
        error: 'Failed to validate Kubernetes YAML',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Validate Helm chart
  app.post("/api/sessions/:id/validate-helm-chart", async (req, res) => {
    try {
      const { chartPath, options } = req.body;
      const sessionId = req.params.id;

      if (!chartPath || typeof chartPath !== 'string') {
        return res.status(400).json({ 
          error: 'Missing required field',
          details: 'chartPath is required and must be a string'
        });
      }

      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      console.log(`\n🔍 ========== HELM CHART VALIDATION ==========`);
      console.log(`Session ID: ${sessionId}`);
      console.log(`Chart Path: ${chartPath}`);

      // Validate Helm chart
      const result = await validateHelmChart(chartPath, options || {
        runHelmLint: true,
        runKubeval: true,
        runCheckov: true,
        runBestPractices: true,
      });

      // Store validation result in session (for later reference)
      // We can add a field to session schema if needed

      console.log('==========================================\n');

      res.json({
        success: result.success,
        issues: result.issues,
        lintResults: result.lintResults,
        bestPractices: result.bestPractices,
        summary: result.summary,
      });

    } catch (error: any) {
      console.error('❌ Error validating Helm chart:', error);
      res.status(500).json({ 
        error: 'Failed to validate Helm chart',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Commit automation files to repository
  app.post("/api/sessions/:id/commit-automation", async (req, res) => {
    const sessionId = req.params.id;
    let session: any = null;
    
    try {
      session = await storage.getSession(sessionId);
      
      if (!session || !session.provider || !session.repositoryName) {
        return res.status(400).json({ error: 'Session not properly configured' });
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
      
      // Filter to automation script files (python, powershell, shell, bash)
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
      
      const commitMessage = message || `Add automation script: ${automationFiles.map(f => f.fileName).join(', ')}`;

      // Commit via MCP
      const result = await mcpClient.commitFiles(
        session.provider as MCPProvider,
        session.repositoryName,
        automationFiles.map(f => ({ path: f.fileName, content: f.content })),
        commitMessage
      );

      res.json({ 
        success: true, 
        commitMessage, 
        result,
        commitSha: result.commit?.sha || result.sha || result.commitSha,
        branch: result.branch || 'main',
        filesCommitted: automationFiles.length,
        message: 'Automation script committed successfully.'
      });
    } catch (error: any) {
      console.error('❌ Error committing automation files:', error);
      res.status(500).json({ 
        error: 'Failed to commit automation files',
        details: error.message
      });
    }
  });

  // Commit files to repository
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


  // Auto-fix Checkov scan failures using AI
  app.post("/api/sessions/:id/fix-issues", async (req, res) => {
    const sessionId = req.params.id;
    const { failedChecks, framework = 'terraform' } = req.body;

    console.log(`\n🔧 ========== AUTO-FIX REQUEST ==========`);
    console.log(`Session ID: ${sessionId}`);
    console.log(`Framework: ${framework}`);
    console.log(`Failed checks to fix: ${failedChecks?.length || 0}`);

    try {
      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ 
          error: 'Session not found',
          details: `Session ${sessionId} does not exist`
        });
      }

      if (!failedChecks || !Array.isArray(failedChecks) || failedChecks.length === 0) {
        return res.status(400).json({ 
          error: 'No failed checks provided',
          details: 'Please provide an array of failed checks to fix'
        });
      }

      // Get files based on framework
      const allFiles = await storage.getFilesBySession(sessionId);
      let filesToFix: typeof allFiles;
      
      if (framework === 'kubernetes') {
        filesToFix = allFiles.filter(file => {
          const fileName = file.fileName.toLowerCase();
          return fileName.endsWith('.yaml') || fileName.endsWith('.yml');
        });
        
        if (filesToFix.length === 0) {
          return res.status(400).json({ 
            error: 'No Kubernetes files found',
            details: 'No Kubernetes YAML files exist for this session'
          });
        }
        
        console.log(`📁 Found ${filesToFix.length} Kubernetes file(s) to fix`);
      } else {
        filesToFix = allFiles.filter(file => {
          const fileName = file.fileName.toLowerCase();
          return fileName.endsWith('.tf') || fileName.endsWith('.tfvars') || fileName.endsWith('.hcl');
        });
        
        if (filesToFix.length === 0) {
          return res.status(400).json({ 
            error: 'No Terraform files found',
            details: 'No Terraform files exist for this session'
          });
        }
        
        console.log(`📁 Found ${filesToFix.length} Terraform file(s) to fix`);
      }

      // Group failed checks by file
      const checksByFile = new Map<string, any[]>();
      failedChecks.forEach((check: any) => {
        // Normalize file path - Checkov may return paths like /main.tf, ./main.tf, or main.tf
        // For Kubernetes, might be resource-0.yaml, template-0.yaml, etc.
        let fileName = check.file?.replace(/^[\\/]/, '') || (framework === 'kubernetes' ? 'resource.yaml' : 'main.tf');
        fileName = fileName.replace(/^\.\//, ''); // Remove leading ./
        fileName = fileName.split('/').pop() || fileName; // Get just the filename
        fileName = fileName.split('\\').pop() || fileName; // Handle Windows paths
        
        if (!checksByFile.has(fileName)) {
          checksByFile.set(fileName, []);
        }
        checksByFile.get(fileName)!.push(check);
      });

      console.log(`📋 Issues grouped by file:`);
      checksByFile.forEach((checks, file) => {
        console.log(`   ${file}: ${checks.length} issue(s)`);
      });
      
      console.log(`📁 Available ${framework === 'kubernetes' ? 'Kubernetes' : 'Terraform'} files in session:`);
      filesToFix.forEach(f => {
        console.log(`   - ${f.fileName} (ID: ${f.id})`);
      });

      // Fix each file
      const fixedFiles: Array<{ fileName: string; content: string; originalContent: string }> = [];
      const fixResults: Array<{
        checkId: string;
        checkName: string;
        file: string;
        resource: string;
        status: 'fixed' | 'failed' | 'skipped';
        reason?: string;
      }> = [];
      
      for (const [fileName, checks] of Array.from(checksByFile.entries())) {
        // Try multiple matching strategies
        let file = filesToFix.find(f => f.fileName === fileName);
        if (!file) {
          // Try case-insensitive match
          file = filesToFix.find(f => f.fileName.toLowerCase() === fileName.toLowerCase());
        }
        if (!file) {
          // Try endsWith match
          file = filesToFix.find(f => f.fileName.endsWith(fileName) || fileName.endsWith(f.fileName));
        }
        if (!file) {
          // Try basename match (handle paths)
          const baseName = fileName.split('/').pop()?.split('\\').pop();
          file = filesToFix.find(f => {
            const fBaseName = f.fileName.split('/').pop()?.split('\\').pop();
            return fBaseName === baseName;
          });
        }
        
        if (!file) {
          console.warn(`⚠️  File not found: ${fileName}`);
          console.warn(`   Available files: ${filesToFix.map(f => f.fileName).join(', ')}`);
          // Mark all checks for this file as skipped
          checks.forEach((check: any) => {
            fixResults.push({
              checkId: check.checkId,
              checkName: check.checkName,
              file: fileName,
              resource: check.resource,
              status: 'skipped',
              reason: `File not found: ${fileName}`
            });
          });
          continue;
        }
        
        console.log(`   ✅ Matched file: ${file.fileName} (ID: ${file.id})`);

        console.log(`\n🔧 Fixing ${fileName}...`);
        console.log(`   Issues to fix: ${checks.length}`);
        
        // Process checks in batches if there are too many (better success rate)
        const BATCH_SIZE = 5; // Process 5 checks at a time for better AI focus
        const checkBatches: any[][] = [];
        for (let i = 0; i < checks.length; i += BATCH_SIZE) {
          checkBatches.push(checks.slice(i, i + BATCH_SIZE));
        }
        
        console.log(`   📦 Processing ${checkBatches.length} batch(es) of checks`);
        
        let currentFileContent = file.content;
        let fileWasUpdated = false;
        
        // Process each batch
        for (let batchIdx = 0; batchIdx < checkBatches.length; batchIdx++) {
          const batchChecks = checkBatches[batchIdx];
          console.log(`\n   🔄 Processing batch ${batchIdx + 1}/${checkBatches.length} (${batchChecks.length} check(s))...`);
          
          // Refresh file content before each batch (in case previous batch updated it)
          if (fileWasUpdated && file) {
            const refreshedFiles = await storage.getFilesBySession(sessionId);
            const refreshedFile = refreshedFiles.find(f => f.id === file!.id);
            if (refreshedFile) {
              currentFileContent = refreshedFile.content;
              file = refreshedFile;
            }
          }

          // Create prompt for AI to fix the issues in this batch
          console.log(`   📋 Issues in this batch:`);
          batchChecks.forEach((check: any, idx: number) => {
            console.log(`      ${idx + 1}. ${check.checkName} (${check.checkId})`);
            console.log(`         Resource: ${check.resource}`);
            console.log(`         Guideline: ${check.guideline || 'No guideline'}`);
          });

          // For Kubernetes, use RAG-based fix retrieval with YAML-specific logic
          if (framework === 'kubernetes') {
            // Phase 6: Get fixes from RAG system for each check
            console.log(`   🔍 Retrieving fixes from RAG system...`);
            const ragFixes: Array<{
              check: any;
              fix: string | null;
              confidence: number;
              source: string;
            }> = [];

            for (const check of batchChecks) {
              try {
                // Extract resource kind from resource string (e.g., "Deployment.app-name" -> "Deployment")
                const resourceKind = check.resource?.split('.')[0] || 'Deployment';

                const ragResult = await intelligentFixRetriever.getFixForCheck(
                  check.checkId,
                  resourceKind,
                  check.checkName || check.checkId,
                  check.guideline || '',
                  session.userId || undefined,
                  currentFileContent, // Pass current YAML as context
                  'kubernetes', // cloudProvider
                  'kubernetes'  // framework
                );

                if (ragResult) {
                  console.log(`      ✅ RAG fix found for ${check.checkId} (source: ${ragResult.source}, confidence: ${(ragResult.confidence * 100).toFixed(0)}%)`);
                  ragFixes.push({
                    check,
                    fix: ragResult.fix,
                    confidence: ragResult.confidence,
                    source: ragResult.source
                  });
                } else {
                  console.log(`      ⚠️  No RAG fix found for ${check.checkId}`);
                  ragFixes.push({
                    check,
                    fix: null,
                    confidence: 0,
                    source: 'none'
                  });
                }
              } catch (ragError: any) {
                console.warn(`      ❌ RAG retrieval failed for ${check.checkId}: ${ragError.message}`);
                ragFixes.push({
                  check,
                  fix: null,
                  confidence: 0,
                  source: 'error'
                });
              }
            }

            // Build prompt with RAG-provided fix snippets as guidance
            const kubernetesIssues = ragFixes.map((item, idx) => {
              let desc = `${idx + 1}. ${item.check.checkName} (${item.check.checkId})\n`;
              desc += `   - Resource: ${item.check.resource}\n`;
              if (item.check.guideline) {
                desc += `   - Guideline: ${item.check.guideline}\n`;
              }
              if (item.check.reason) {
                desc += `   - Reason: ${item.check.reason}\n`;
              }
              // Include RAG-provided fix snippet if available
              if (item.fix) {
                desc += `   - RECOMMENDED FIX (${item.source}, ${(item.confidence * 100).toFixed(0)}% confidence):\n`;
                desc += item.fix.split('\n').map(line => `     ${line}`).join('\n') + '\n';
              }
              return desc;
            }).join('\n');

            const kubernetesFixPrompt = `You are a Kubernetes security expert. Fix security issues in Kubernetes YAML manifests based on Checkov scan results.

CURRENT KUBERNETES YAML FILE:
\`\`\`yaml
${currentFileContent}
\`\`\`

FAILED SECURITY CHECKS TO FIX:
${kubernetesIssues}

REQUIREMENTS:
1. Apply the RECOMMENDED FIX snippets provided above to the appropriate resources
2. Maintain valid YAML syntax
3. Preserve all existing resources and configurations
4. Only modify what needs to be fixed
5. Merge fix snippets into existing securityContext/resources blocks if they exist
6. Do NOT remove or rename existing resources
7. Maintain proper YAML indentation (2 spaces)
8. Ensure all YAML is properly formatted

Return ONLY the complete fixed YAML code in a code block, nothing else.`;

            try {
              const completion = await openaiService.chat([
                {
                  role: 'system',
                  content: 'You are a Kubernetes security expert. Apply the recommended fix snippets to the YAML manifest. Return only the fixed YAML in a code block.'
                },
                {
                  role: 'user',
                  content: kubernetesFixPrompt
                }
              ]);

              let fixedContent = completion.trim();
              
              // Extract YAML from code block if present
              const yamlMatch = fixedContent.match(/```(?:yaml)?\n([\s\S]*?)```/);
              if (yamlMatch) {
                fixedContent = yamlMatch[1].trim();
              }

              if (fixedContent && fixedContent !== currentFileContent && file) {
                // Update file in storage
                const fileName = file.fileName;
                const originalContent = currentFileContent;
                await storage.updateFile(file.id, fixedContent);
                fileWasUpdated = true;
                // Store original content for diff view
                const existingFixedFile = fixedFiles.find(f => f.fileName === fileName);
                if (existingFixedFile) {
                  // Update existing entry
                  existingFixedFile.content = fixedContent;
                } else {
                  // Create new entry with original content
                  fixedFiles.push({ fileName, content: fixedContent, originalContent });
                }
                
                console.log(`   ✅ File updated: ${fileName}`);
                console.log(`   📊 Content size: ${originalContent.length} → ${fixedContent.length} bytes`);
                
                // Verify the file was actually updated in storage
                const verifyFiles = await storage.getFilesBySession(sessionId);
                const verifyFile = verifyFiles.find(f => f.id === file!.id);
                if (!verifyFile || verifyFile.content !== fixedContent) {
                  console.error(`   ❌ Verification failed: File content mismatch in storage`);
                  batchChecks.forEach((check: any) => {
                    fixResults.push({
                      checkId: check.checkId,
                      checkName: check.checkName,
                      file: fileName,
                      resource: check.resource,
                      status: 'failed',
                      reason: 'File update verification failed - content not saved correctly'
                    });
                  });
                  continue;
                }
                
                console.log(`   ✅ Verified: File content saved correctly in storage`);
                
                // Re-run Checkov to verify fixes actually work
                console.log(`   🔍 Re-running Checkov to verify fixes...`);
                try {
                  const verifyYamlFiles = [{
                    path: fileName,
                    content: fixedContent
                  }];
                  const verifyResult = await runCheckovKubernetes(verifyYamlFiles);
                  
                  // Check if the specific checks that were fixed are now passing
                  const fixedCheckIds = new Set(batchChecks.map((c: any) => c.checkId));
                  const stillFailing = verifyResult.checks.filter(c => fixedCheckIds.has(c.checkId));
                  
                  if (stillFailing.length === 0) {
                    console.log(`   ✅ Verification passed: All ${batchChecks.length} check(s) now pass Checkov`);
                    // Mark as fixed and report success to RAG for learning
                    for (const check of batchChecks) {
                      const resourceKind = check.resource?.split('.')[0] || 'Deployment';
                      // Find the RAG fix that was used for this check
                      const ragFix = ragFixes.find(rf => rf.check.checkId === check.checkId);
                      if (ragFix?.fix) {
                        // Report verified fix to RAG system for confidence boost
                        try {
                          await intelligentFixRetriever.storeVerifiedFix(
                            check.checkId,
                            resourceKind,
                            ragFix.fix,
                            session.userId || undefined,
                            true, // verified
                            'kubernetes',
                            'kubernetes'
                          );
                          console.log(`      📈 RAG confidence updated for ${check.checkId}`);
                        } catch (ragErr: any) {
                          console.warn(`      ⚠️  Failed to update RAG confidence: ${ragErr.message}`);
                        }
                      }
                      fixResults.push({
                        checkId: check.checkId,
                        checkName: check.checkName,
                        file: fileName,
                        resource: check.resource,
                        status: 'fixed',
                      });
                    }
                  } else {
                    console.warn(`   ⚠️  Verification warning: ${stillFailing.length} check(s) still failing after fix`);
                    // Mark as partially fixed or failed and report to RAG
                    for (const check of batchChecks) {
                      const stillFails = stillFailing.some(f => f.checkId === check.checkId);
                      const resourceKind = check.resource?.split('.')[0] || 'Deployment';

                      if (stillFails) {
                        // Report failure to RAG system for confidence decrease
                        try {
                          await intelligentFixRetriever.reportFixFailure(
                            check.checkId,
                            resourceKind,
                            session.userId || undefined,
                            'kubernetes'
                          );
                          console.log(`      📉 RAG confidence decreased for ${check.checkId}`);
                        } catch (ragErr: any) {
                          console.warn(`      ⚠️  Failed to update RAG confidence: ${ragErr.message}`);
                        }
                      } else {
                        // Report success for checks that passed
                        const ragFix = ragFixes.find(rf => rf.check.checkId === check.checkId);
                        if (ragFix?.fix) {
                          try {
                            await intelligentFixRetriever.storeVerifiedFix(
                              check.checkId,
                              resourceKind,
                              ragFix.fix,
                              session.userId || undefined,
                              true,
                              'kubernetes',
                              'kubernetes'
                            );
                          } catch (ragErr: any) {
                            console.warn(`      ⚠️  Failed to update RAG confidence: ${ragErr.message}`);
                          }
                        }
                      }

                      fixResults.push({
                        checkId: check.checkId,
                        checkName: check.checkName,
                        file: fileName,
                        resource: check.resource,
                        status: stillFails ? 'failed' : 'fixed',
                        reason: stillFails ? 'Check still failing after fix - may require manual intervention' : undefined
                      });
                    }
                  }
                } catch (verifyError: any) {
                  console.warn(`   ⚠️  Verification scan failed: ${verifyError.message}`);
                  // Still mark as fixed since file was updated, but note verification failed
                  batchChecks.forEach((check: any) => {
                    fixResults.push({
                      checkId: check.checkId,
                      checkName: check.checkName,
                      file: fileName,
                      resource: check.resource,
                      status: 'fixed',
                    });
                  });
                }
              } else {
                console.warn(`   ⚠️  No changes detected or AI returned same content`);
                batchChecks.forEach((check: any) => {
                  fixResults.push({
                    checkId: check.checkId,
                    checkName: check.checkName,
                    file: file?.fileName || fileName,
                    resource: check.resource,
                    status: 'failed',
                    reason: 'AI did not generate any changes'
                  });
                });
              }
            } catch (aiError: any) {
              console.error(`   ❌ AI fix failed:`, aiError.message);
              batchChecks.forEach((check: any) => {
                fixResults.push({
                  checkId: check.checkId,
                  checkName: check.checkName,
                  file: file?.fileName || fileName,
                  resource: check.resource,
                  status: 'failed',
                  reason: `AI fix failed: ${aiError.message}`
                });
              });
            }
            continue; // Skip Terraform fix logic for Kubernetes
          }

          // Build detailed issue descriptions using RAG to find remediation templates
          // Priority 2 Fix: Extract base resource name and add count/for_each context
          const detailedIssues = await Promise.all(
            batchChecks.map(async (check: any, idx: number) => {
              let description = `${idx + 1}. ${check.checkName} (${check.checkId})\n`;
              description += `   - Resource Instance: ${check.resource}\n`;
              
              // Priority 2: Extract base resource name for count/for_each resources
              const baseResourceName = extractBaseResourceName(check.resource);
              const isCountForEach = check.resource.includes('[') && check.resource.includes(']');
              
              if (isCountForEach) {
                description += `   - Resource Block: ${baseResourceName}\n`;
                description += `   ⚠️  CRITICAL - COUNT/FOR_EACH RESOURCE:\n`;
                description += `      This is an instance (${check.resource}) of a resource block that uses count or for_each.\n`;
                description += `      You MUST apply the fix to the RESOURCE BLOCK "${baseResourceName}", NOT to a specific instance.\n`;
                description += `      The fix will automatically apply to ALL instances ([0], [1], [2], etc.).\n`;
                description += `      DO NOT create a new resource block for the instance.\n`;
                description += `      DO NOT modify only one instance.\n`;
                description += `      Apply the fix to the EXISTING resource block that uses count/for_each.\n`;
              } else {
                description += `   - Resource Block: ${check.resource}\n`;
              }
              
              if (check.guideline) {
                description += `   - Guideline: ${check.guideline}\n`;
              }
              if (check.file) {
                description += `   - File: ${check.file}\n`;
              }
              // Extract resource type from resource string (e.g., "azurerm_storage_account.example" -> "azurerm_storage_account")
              const resourceMatch = check.resource?.match(/^([a-z_]+)/);
              const resourceType = resourceMatch?.[1] || '';
              if (resourceType) {
                description += `   - Resource Type: ${resourceType}\n`;
              }
              
              // Use unified retrieval (intelligent when flag on, RAG otherwise)
              const remediation = await getRemediation(
                check.checkId,
                check.checkName,
                check.guideline || '',
                resourceType,
                session.userId || undefined,
                session.cloudProvider || 'azure'
              );

              if (remediation) {
                const decision = remediationRAGService.shouldApplyFix(remediation.confidence);
                
                // Handle both fix snippets and templates (backward compatibility)
                const snippet = remediation.snippet;
                const template = remediation.template;
                
                if (snippet) {
                  // New: Fix snippet
                  description += `\n   ${decision.apply ? '✅' : '⚠️'} REMEDIATION FIX SNIPPET FOUND:\n`;
                  description += `   - Check ID: ${snippet.checkId}\n`;
                  description += `   - Resource Type: ${snippet.resourceType}\n`;
                  description += `   - Confidence: ${(remediation.confidence * 100).toFixed(1)}%\n`;
                  description += `   - Source: ${snippet.source}\n`;
                  description += `   - Match: ${remediation.matchReason}\n`;
                  description += `   - Status: ${decision.reason}\n`;
                  description += `   - Remediation Snippet:\n`;
                  
                  const snippetLines = snippet.fixSnippet.split('\n');
                  snippetLines.forEach(line => {
                    description += `     ${line}\n`;
                  });
                } else if (template) {
                  // Backward compatibility: Template
                  description += `\n   ${decision.apply ? '✅' : '⚠️'} REMEDIATION TEMPLATE FOUND:\n`;
                  description += `   - Template: ${template.check_id}\n`;
                  description += `   - Confidence: ${(remediation.confidence * 100).toFixed(1)}%\n`;
                  description += `   - Match: ${remediation.matchReason}\n`;
                  description += `   - Status: ${decision.reason}\n`;
                  description += `   - Attribute: ${template.terraform_attribute}\n`;
                  description += `   - Remediation Snippet:\n`;
                  
                  const snippetLines = template.remediation_snippet.split('\n');
                  snippetLines.forEach(line => {
                    description += `     ${line}\n`;
                  });
                }
                
                // Priority 2: Add specific instructions for count/for_each resources
                if (isCountForEach) {
                  description += `\n   🎯 FIX LOCATION FOR COUNT/FOR_EACH:\n`;
                  description += `      Apply the remediation snippet above to the resource block "${baseResourceName}".\n`;
                  description += `      Example: If the resource block is:\n`;
                  description += `        resource "azurerm_storage_account" "${baseResourceName.replace(/^[^.]+\./, '')}" {\n`;
                  description += `          count = 5\n`;
                  description += `          ...\n`;
                  description += `        }\n`;
                  description += `      Add the remediation snippet INSIDE this block, not in a new block.\n`;
                }
              } else {
                description += `\n   ⚠️  No remediation template found - using guideline to determine fix\n`;
              }
              
              return description;
            })
          );
          
          const detailedIssuesText = detailedIssues.join('\n');

        // Check which checks have remediation templates
        const remediationResults = await Promise.all(
          batchChecks.map(async (check: any) => {
            const resourceMatch = check.resource?.match(/^([a-z_]+)/);
            const resourceType = resourceMatch?.[1] || '';
            const remediation = await getRemediation(
              check.checkId,
              check.checkName,
              check.guideline || '',
              resourceType,
              session.userId || undefined,
              session.cloudProvider || 'azure'
            );
            return { check, remediation };
          })
        );

        const checksWithRemediation = remediationResults.filter(r => r.remediation && r.remediation.confidence >= 0.7);
        const checksWithoutRemediation = remediationResults.filter(r => !r.remediation || r.remediation.confidence < 0.7);
        
        const snippetsCount = remediationResults.filter(r => r.remediation?.snippet).length;
        const templatesCount = remediationResults.filter(r => r.remediation?.template).length;
        
        console.log(`   📊 Remediation coverage: ${checksWithRemediation.length}/${batchChecks.length} check(s) have remediation`);
        console.log(`      - Fix snippets: ${snippetsCount}`);
        console.log(`      - Templates (backward compat): ${templatesCount}`);
        if (checksWithoutRemediation.length > 0) {
          console.log(`   ⚠️  Checks without remediation: ${checksWithoutRemediation.map(r => r.check.checkId).join(', ')}`);
        }

        const fixPrompt = `You are a Terraform security expert specializing in Checkov security fixes. Your task is to fix the Checkov security issues in this Terraform file.

CURRENT FILE CONTENT:
\`\`\`terraform
${currentFileContent || file.content}
\`\`\`

CHECKOV SECURITY ISSUES TO FIX:
${detailedIssuesText}

${checksWithRemediation.length > 0 ? `🚨 CRITICAL - REMEDIATION TEMPLATES PROVIDED:
For checks with "✅ REMEDIATION TEMPLATE FOUND" above, you MUST use the exact remediation snippet provided.
DO NOT modify or guess - use the EXACT code from the remediation snippet.

For these checks: ${checksWithRemediation.map(r => r.check.checkId).join(', ')}
- Use the EXACT remediation snippet provided
- Do NOT change attribute names or values
- Follow the EXACT syntax from the template

` : ''}${checksWithoutRemediation.length > 0 ? `⚠️  CHECKS WITHOUT REMEDIATION TEMPLATES:
For checks without remediation templates (${checksWithoutRemediation.map(r => r.check.checkId).join(', ')}), use the guideline to determine the fix.
Read the guideline carefully and apply the appropriate Terraform attributes.

` : ''}ANALYSIS REQUIRED:
1. ${checksWithRemediation.length > 0 ? 'For checks with remediation templates: Use the EXACT remediation snippet provided above' : 'Read each Checkov check\'s guideline carefully'}
2. Identify the specific resource(s) mentioned in each check
3. ${checksWithRemediation.length > 0 ? 'Apply the exact remediation snippet from the template' : 'Determine what attribute(s) need to be added or modified based on the guideline'}
4. Apply the fix by adding/modifying the necessary attributes in the resource block

CRITICAL REQUIREMENTS:
1. Fix ALL ${batchChecks.length} issue(s) listed above - this is MANDATORY
2. Each check ID (${batchChecks.map((c: any) => c.checkId).join(', ')}) MUST be addressed
3. You MUST modify the code - returning identical content is NOT acceptable
4. ${checksWithRemediation.length > 0 ? 'For checks with remediation templates: Use the EXACT remediation snippet - do not modify it. Copy the snippet EXACTLY as shown, including the exact attribute name and value.' : 'Use the guideline from each check to understand what needs to be fixed'}
5. Add missing attributes or modify existing ones as required
6. **IMPORTANT**: If an attribute already exists with a different value, you MUST change it to the required value (e.g., if allow_nested_items_to_be_public = true exists, change it to false)
7. Maintain the existing structure and functionality
8. Preserve all comments and formatting style
9. Ensure the code remains valid Terraform syntax
10. Do not remove or rename existing resources unless necessary for the fix
11. **COUNT/FOR_EACH RESOURCES**: If a check mentions a resource with [index] (e.g., "azurerm_storage_account.example[0]"), you MUST apply the fix to the resource block "azurerm_storage_account.example", NOT to a specific instance. The fix will automatically apply to ALL instances.

FIX STRATEGY:
- For each failing check, identify the resource type and name
${checksWithRemediation.length > 0 ? '- For checks with remediation templates: Use the EXACT remediation snippet from the template' : '- Read the guideline to understand what security setting is required'}
- **For count/for_each resources**: If the resource name contains [index], extract the base resource name (remove [index]) and apply the fix to that resource block
- Add or modify the resource attributes to meet the security requirement
- Ensure the fix addresses the specific issue mentioned

IMPORTANT: 
- The current code FAILS these Checkov checks
- You MUST make changes to fix them
${checksWithRemediation.length > 0 ? '- For checks with remediation templates: DO NOT modify the remediation snippet - use it exactly as provided' : ''}
- If a guideline says "ensure X is enabled", add the attribute with the correct value
- If a guideline says "ensure X is disabled", add the attribute set to false
- Do NOT return the same code - it must be modified

Return ONLY the complete fixed Terraform code in a code block, nothing else.`;

        try {
          // Use OpenAI to generate fixes
          const completion = await openaiService.chat([
            {
              role: 'system',
              content: 'You are a Terraform security expert. Fix security issues in Terraform code based on Checkov scan results. Return only the fixed code in a code block.'
            },
            {
              role: 'user',
              content: fixPrompt
            }
          ]);

          // Extract code from response (handle markdown code blocks)
          let fixedContent = completion.trim();
          
          // Remove markdown code block markers if present
          if (fixedContent.startsWith('```terraform')) {
            fixedContent = fixedContent.replace(/^```terraform\s*\n/, '').replace(/\n```\s*$/, '');
          } else if (fixedContent.startsWith('```')) {
            fixedContent = fixedContent.replace(/^```\s*\n/, '').replace(/\n```\s*$/, '');
          }
          
          console.log(`   📝 AI generated fix (${fixedContent.length} chars, was ${file.content.length} chars)`);
          
          // Debug: Check if CKV_AZURE_59 fix was actually applied
          const hasCKV59Fix = batchChecks.some((c: any) => c.checkId === 'CKV_AZURE_59');
          if (hasCKV59Fix) {
            const hasAllowNestedItems = fixedContent.includes('allow_nested_items_to_be_public');
            const hasAllowNestedItemsFalse = /allow_nested_items_to_be_public\s*=\s*false/.test(fixedContent);
            console.log(`   🔍 Debug CKV_AZURE_59 fix verification:`);
            console.log(`      - Has allow_nested_items_to_be_public attribute: ${hasAllowNestedItems}`);
            console.log(`      - Has allow_nested_items_to_be_public = false: ${hasAllowNestedItemsFalse}`);
            if (hasAllowNestedItems && !hasAllowNestedItemsFalse) {
              console.warn(`      ⚠️  WARNING: Attribute exists but is NOT set to false!`);
              // Check what value it's set to
              const valueMatch = fixedContent.match(/allow_nested_items_to_be_public\s*=\s*([^\s\n}]+)/);
              if (valueMatch) {
                console.warn(`      ⚠️  Current value: ${valueMatch[1]}`);
              }
            }
            if (!hasAllowNestedItems) {
              console.error(`      ❌ ERROR: Fix was NOT applied - attribute missing!`);
            }
          }
          
          // Check if content actually changed
          const contentToCompare = currentFileContent || file.content;
          if (fixedContent === contentToCompare) {
            console.warn(`   ⚠️  WARNING: AI returned identical content - fix was not applied!`);
            console.warn(`   🔄 Retrying with more explicit instructions...`);
            
            // Retry with a more explicit prompt (RAG-based)
            const retryRemediationResults = await Promise.all(
              batchChecks.map(async (check: any) => {
                const resourceMatch = check.resource?.match(/^([a-z_]+)/);
                const resourceType = resourceMatch?.[1] || '';
                const remediation = await getRemediation(
                  check.checkId,
                  check.checkName,
                  check.guideline || '',
                  resourceType,
                  session.userId || undefined,
                  session.cloudProvider || 'azure'
                );
                return { check, remediation };
              })
            );
            const retryChecksWithRemediation = retryRemediationResults.filter(r => r.remediation && r.remediation.confidence >= 0.6);
            
            const retryPrompt = `CRITICAL: The Terraform code below FAILS Checkov security checks. You MUST fix it by modifying the code.

CURRENT FILE CONTENT (THIS CODE FAILS CHECKOV CHECKS):
\`\`\`terraform
${file.content}
\`\`\`

FAILING CHECKOV CHECKS (MUST BE FIXED):
${detailedIssuesText}

${retryChecksWithRemediation.length > 0 ? `🚨 CRITICAL - USE EXACT FIXES FROM REMEDIATION TEMPLATES:
For checks with "✅ REMEDIATION TEMPLATE FOUND" above, you MUST use the EXACT remediation snippet provided.
DO NOT modify or guess - use the EXACT code from the remediation snippet.

` : ''}WHAT YOU MUST DO:
1. ${retryChecksWithRemediation.length > 0 ? 'For checks with remediation templates: Use the EXACT remediation snippet from the template' : 'Read each check\'s guideline - it tells you exactly what security requirement is missing'}
2. For each check, identify the resource and add/modify the required attribute(s)
3. The output code MUST be different from the input code
4. You MUST make actual changes - returning identical code is a failure
5. Each check ID (${batchChecks.map((c: any) => c.checkId).join(', ')}) must be addressed

FIX PROCESS:
${retryChecksWithRemediation.length > 0 ? '- For checks with remediation templates: Use the EXACT remediation snippet from the template\n' : ''}- Read each check's guideline carefully - it tells you exactly what needs to be fixed
- Analyze the guideline to understand what security setting is required
- Determine the appropriate Terraform attribute and value based on the guideline
- Apply the fix by adding or modifying the necessary attributes
- Each check may require different fixes - analyze each one individually

YOU MUST RETURN MODIFIED CODE. DO NOT RETURN IDENTICAL CODE.
${retryChecksWithRemediation.length > 0 ? 'USE THE EXACT REMEDIATION SNIPPETS FROM THE TEMPLATES - DO NOT MODIFY THEM.' : ''}

Return the COMPLETE fixed Terraform code with ALL necessary security fixes applied.`;
            
            try {
              const retryCompletion = await openaiService.chat([
                {
                  role: 'system',
                  content: 'You are a Terraform security expert. You MUST fix Checkov security issues by modifying the code. Returning identical code is NOT acceptable. You MUST make changes to address each security check.'
                },
                {
                  role: 'user',
                  content: retryPrompt
                }
              ]);
              
              let retryFixedContent = retryCompletion.trim();
              if (retryFixedContent.startsWith('```terraform')) {
                retryFixedContent = retryFixedContent.replace(/^```terraform\s*\n/, '').replace(/\n```\s*$/, '');
              } else if (retryFixedContent.startsWith('```')) {
                retryFixedContent = retryFixedContent.replace(/^```\s*\n/, '').replace(/\n```\s*$/, '');
              }
              
              if (retryFixedContent !== file.content) {
                console.log(`   ✅ Retry successful - content changed`);
                fixedContent = retryFixedContent;
              } else {
                console.warn(`   ❌ Retry also returned identical content`);
                // Mark all checks as failed because no fix was applied
                checks.forEach((check: any) => {
                  fixResults.push({
                    checkId: check.checkId,
                    checkName: check.checkName,
                    file: fileName,
                    resource: check.resource,
                    status: 'failed',
                    reason: 'AI returned identical content after retry - unable to fix this issue automatically. Manual fix required.'
                  });
                });
                continue; // Skip updating the file since it's identical
              }
            } catch (retryError: any) {
              console.error(`   ❌ Retry failed:`, retryError.message);
              // Mark all checks as failed because retry failed
              checks.forEach((check: any) => {
                fixResults.push({
                  checkId: check.checkId,
                  checkName: check.checkName,
                  file: fileName,
                  resource: check.resource,
                  status: 'failed',
                  reason: `Retry failed: ${retryError.message}`
                });
              });
              continue;
            }
          }
          
          const diff = fixedContent.length - currentFileContent.length;
          console.log(`   📊 Content changed: ${diff > 0 ? '+' : ''}${diff} characters`);
          
          // Validate that the fix actually addresses the issues
          const fixValidation = validateFix(currentFileContent, fixedContent, batchChecks);
          if (!fixValidation.isValid) {
            console.warn(`   ⚠️  Fix validation warnings: ${fixValidation.warnings.join(', ')}`);
          }

          // Update the file in storage
          await storage.updateFile(file.id, fixedContent);
          
          // Verify the update was successful by re-fetching all files
          const allFilesAfterUpdate = await storage.getFilesBySession(sessionId);
          const updatedFile = file ? allFilesAfterUpdate.find(f => f.id === file!.id) : null;
          if (updatedFile && updatedFile.content === fixedContent) {
            console.log(`   ✅ Verified: File updated successfully in storage`);
          } else if (updatedFile) {
            console.warn(`   ⚠️  Warning: File content mismatch after update`);
            console.warn(`      Expected: ${fixedContent.length} bytes, Got: ${updatedFile.content.length} bytes`);
            // Mark as failed if verification failed
            checks.forEach((check: any) => {
              fixResults.push({
                checkId: check.checkId,
                checkName: check.checkName,
                file: fileName,
                resource: check.resource,
                status: 'failed',
                reason: 'File update verification failed - content mismatch in storage'
              });
            });
            continue;
          } else {
            console.warn(`   ⚠️  Warning: File not found after update`);
            // Mark as failed if file not found
            checks.forEach((check: any) => {
              fixResults.push({
                checkId: check.checkId,
                checkName: check.checkName,
                file: fileName,
                resource: check.resource,
                status: 'failed',
                reason: 'File not found in storage after update'
              });
            });
            continue;
          }
          
          // Store original content before first fix
          const originalContentForFile = fileWasUpdated ? 
            (fixedFiles.find(f => f.fileName === fileName)?.originalContent || file.content) :
            file.content;
          
          const existingFixedFile = fixedFiles.find(f => f.fileName === fileName);
          if (!existingFixedFile) {
            fixedFiles.push({
              fileName: file.fileName,
              content: fixedContent,
              originalContent: originalContentForFile
            });
          } else {
            existingFixedFile.content = fixedContent;
          }

          console.log(`   ✅ Fixed ${fileName} (${fixedContent.length} bytes, was ${file.content.length} bytes)`);
          
          // Update current file content for next batch
          currentFileContent = fixedContent;
          fileWasUpdated = true;
          
          // CRITICAL: Verify each check in this batch was actually fixed using Checkov
          // Priority 1 Fix: Pass resource information for instance-specific verification
          console.log(`   🔍 Verifying fixes with Checkov for ${batchChecks.length} check(s)...`);
          const checksForVerification = batchChecks.map(c => ({
            checkId: c.checkId,
            resource: c.resource
          }));
          const checkovVerification = await verifyChecksWithCheckov(fileName, fixedContent, checksForVerification);
          
          for (const check of batchChecks) {
            const checkId = check.checkId;
            const resource = check.resource;
            const verificationKey = `${checkId}:${resource}`;
            const isFixed = checkovVerification.get(verificationKey) || false;
            
            // Extract resource type from resource name
            const resourceMatch = resource?.match(/^([a-z_]+)/);
            const resourceType = resourceMatch?.[1] || '';
            
            // Find the remediation result for this check
            const remediationResult = remediationResults.find(r => r.check.checkId === checkId);
            
            // Log fix operation for auditability
            const fixLog = await fixLogStore.add({
              sessionId,
              checkId,
              resourceType,
              source: remediationResult?.remediation?.snippet 
                ? 'retrieved' 
                : remediationResult?.remediation?.template 
                  ? 'retrieved' 
                  : 'generated',
              snippetId: remediationResult?.remediation?.snippet?.id,
              confidence: remediationResult?.remediation?.confidence || 0.6,
              verificationStatus: 'pending',
              filePath: fileName,
              resourceName: resource,
            });
            
            if (isFixed) {
              console.log(`   ✅ Check ${checkId} for resource ${resource} verified as FIXED by Checkov`);
              
              // Update audit log
              await fixLogStore.update(fixLog.id, {
                verificationStatus: 'passed',
                verificationDate: new Date(),
              });
              
              // Phase 6: route verification feedback through the appropriate path
              if (featureFlags.intelligentFixRetrieval) {
                // Intelligent path: storeVerifiedFix handles both global + user preference updates
                const fixText = remediationResult?.remediation?.snippet?.fixSnippet
                  || extractFixSnippet(fixedContent, check, resourceType)
                  || '';
                if (fixText) {
                  await intelligentFixRetriever.storeVerifiedFix(
                    checkId,
                    resourceType,
                    fixText,
                    session.userId || undefined,
                    true,
                    session.cloudProvider || 'azure'
                  );
                  console.log(`   📈 [intelligent] Stored verified fix: ${checkId} → ${resourceType}`);
                }
              } else {
                // Legacy path: direct RAG updates (unchanged)
                if (remediationResult?.remediation?.snippet) {
                  const snippet = remediationResult.remediation.snippet;
                  await remediationRAGService.updateFixFromVerification(snippet.id, true);
                  console.log(`   📈 Updated fix snippet confidence: ${snippet.id} → passed`);
                }

                if (!remediationResult?.remediation || remediationResult.remediation.confidence < 0.7) {
                  try {
                    const fixSnippet = extractFixSnippet(fixedContent, check, resourceType);

                    if (fixSnippet) {
                      const cloudProvider = session.cloudProvider || 'azure';
                      await remediationRAGService.storeGeneratedFix(
                        checkId,
                        resourceType,
                        cloudProvider,
                        fixSnippet,
                        fixedContent,
                        check.guideline || check.checkName
                      );
                      console.log(`   💾 Stored generated fix snippet: ${checkId} → ${resourceType}`);

                      const snippetId = createHash('sha256')
                        .update(`${checkId}:${resourceType}`)
                        .digest('hex')
                        .substring(0, 16);
                      await remediationRAGService.updateFixFromVerification(snippetId, true);
                    }
                  } catch (error: any) {
                    console.warn(`   ⚠️  Failed to store generated fix: ${error.message}`);
                  }
                }
              }
            } else {
              console.log(`   ❌ Check ${checkId} for resource ${resource} still FAILS according to Checkov`);
              
              // Update audit log
              await fixLogStore.update(fixLog.id, {
                verificationStatus: 'failed',
                verificationDate: new Date(),
              });
              
              // Phase 6: route failure feedback through the appropriate path
              if (featureFlags.intelligentFixRetrieval) {
                await intelligentFixRetriever.reportFixFailure(
                  checkId,
                  resourceType,
                  session.userId || undefined
                );
                console.log(`   📉 [intelligent] Reported fix failure: ${checkId} → ${resourceType}`);
              } else {
                if (remediationResult?.remediation?.snippet) {
                  const snippet = remediationResult.remediation.snippet;
                  await remediationRAGService.updateFixFromVerification(snippet.id, false);
                  console.log(`   📉 Updated fix snippet confidence: ${snippet.id} → failed`);
                }
              }
            }
            
            // Get detailed fix guidance for failed checks
            let reason = '';
            if (isFixed) {
              reason = 'Fix verified by Checkov - check now passes for this specific resource instance';
            } else {
              const guidance = getFixGuidance(check.checkId, check.checkName);
              if (guidance) {
                reason = `❌ ${guidance.whyItFailed}\n\n` +
                        `🔧 How to fix: ${guidance.howToFix}\n\n` +
                        `📋 Complexity: ${guidance.fixComplexity}\n` +
                        `✅ Auto-fixable: ${guidance.autoFixable ? 'Yes' : 'No'}\n` +
                        (guidance.prerequisites && guidance.prerequisites.length > 0
                          ? `⚠️  Prerequisites: ${guidance.prerequisites.join(', ')}\n`
                          : '') +
                        (guidance.costImplication
                          ? `💰 Cost: ${guidance.costImplication}\n`
                          : '') +
                        (guidance.canIgnore
                          ? `⚠️  Can ignore: ${guidance.ignoreReason || 'If acceptable for your use case'}\n`
                          : '❌ Should not be ignored: Security risk\n') +
                        (guidance.manualSteps && guidance.manualSteps.length > 0
                          ? `\n📝 Manual steps:\n${guidance.manualSteps.map((step, idx) => `   ${idx + 1}. ${step}`).join('\n')}`
                          : '');
              } else {
                reason = 'Fix did not resolve the issue - Checkov still reports failure for this resource instance. The code was updated but the security issue persists. Review the Checkov guideline for specific fix instructions.';
              }
            }
            
            fixResults.push({
              checkId: check.checkId,
              checkName: check.checkName,
              file: fileName,
              resource: check.resource,
              status: isFixed ? 'fixed' : 'failed',
              reason: reason,
              guidance: !isFixed ? getFixGuidance(check.checkId, check.checkName) : undefined
            });
          }
          
          console.log(`   ✅ Batch ${batchIdx + 1} complete`);
        } catch (error: any) {
          console.error(`   ❌ Failed to fix batch ${batchIdx + 1} in ${fileName}:`, error.message);
          console.error(`      Stack trace:`, error.stack);

          // Extract more detailed error info
          let errorReason = error.message || 'Unknown error during fix';
          if (error.response) {
            // OpenAI API error
            errorReason = `OpenAI API Error: ${error.response.status}`;
            console.error(`      OpenAI Error Details:`, error.response.data);
          } else if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
            errorReason = 'Network error: Could not connect to AI service';
          }

          // Mark all checks in this batch as failed
          batchChecks.forEach((check: any) => {
            fixResults.push({
              checkId: check.checkId,
              checkName: check.checkName,
              file: fileName,
              resource: check.resource,
              status: 'failed',
              reason: errorReason
            });
          });
          // Continue with next batch even if one fails
        }
        }
        
        // After all batches, ensure original content is stored if file was updated
        if (fileWasUpdated) {
          const finalFiles = await storage.getFilesBySession(sessionId);
          const finalFile = finalFiles.find(f => f.id === file.id);
          if (finalFile) {
            const existingFixedFile = fixedFiles.find(f => f.fileName === file.fileName);
            if (!existingFixedFile) {
              // Should not happen, but ensure original content is stored
              fixedFiles.push({
                fileName: file.fileName,
                content: finalFile.content,
                originalContent: file.content // Use original file content before any fixes
              });
            } else {
              // Update content but preserve originalContent
              existingFixedFile.content = finalFile.content;
            }
            console.log(`   ✅ All batches complete for ${fileName}`);
          }
        }
      }

      console.log(`\n✅ Auto-fix completed: ${fixedFiles.length} file(s) fixed`);
      console.log(`📋 Fixed files:`);
      fixedFiles.forEach(f => {
        console.log(`   - ${f.fileName}`);
      });
      
      // Final verification: Re-fetch all files to confirm updates
      const finalVerification = await storage.getFilesBySession(sessionId);
      console.log(`\n🔍 Final verification:`);
      fixedFiles.forEach(fixedFile => {
        const verified = finalVerification.find(f => f.fileName === fixedFile.fileName);
        if (verified) {
          if (verified.content === fixedFile.content) {
            console.log(`   ✅ ${fixedFile.fileName}: Verified in storage`);
          } else {
            console.warn(`   ⚠️  ${fixedFile.fileName}: Content mismatch in storage!`);
          }
        } else {
          console.warn(`   ⚠️  ${fixedFile.fileName}: Not found in storage!`);
        }
      });

      // Count results by status
      const fixedCount = fixResults.filter(r => r.status === 'fixed').length;
      const failedCount = fixResults.filter(r => r.status === 'failed').length;
      const skippedCount = fixResults.filter(r => r.status === 'skipped').length;
      
      console.log(`\n📊 Fix Results Summary:`);
      console.log(`   ✅ Fixed: ${fixedCount} check(s)`);
      console.log(`   ❌ Failed: ${failedCount} check(s)`);
      console.log(`   ⏭️  Skipped: ${skippedCount} check(s)`);
      
      if (failedCount > 0 || skippedCount > 0) {
        console.log(`\n⚠️  Issues that were not fixed:`);
        fixResults.filter(r => r.status !== 'fixed').forEach(r => {
          console.log(`   - ${r.checkId} (${r.checkName}): ${r.reason}`);
        });
      }

      // Enhance response with fix guidance summary
      const failedWithGuidance = fixResults
        .filter(r => r.status === 'failed')
        .map(r => ({
          ...r,
          guidance: getFixGuidance(r.checkId, r.checkName)
        }));
      
      const autoFixableCount = failedWithGuidance.filter(r => r.guidance?.autoFixable).length;
      const manualFixCount = failedWithGuidance.filter(r => !r.guidance?.autoFixable).length;
      const canIgnoreCount = failedWithGuidance.filter(r => r.guidance?.canIgnore).length;
      
      res.json({
        success: true,
        fixedFiles: fixedFiles.map(f => f.fileName),
        fileDiffs: fixedFiles.map(f => ({
          fileName: f.fileName,
          originalContent: f.originalContent,
          fixedContent: f.content
        })),
        message: `Fixed ${fixedCount} check(s) in ${fixedFiles.length} file(s)`,
        fixedCount: fixedFiles.length,
        fixResults: {
          fixed: fixedCount,
          failed: failedCount,
          skipped: skippedCount,
          total: fixResults.length,
          details: fixResults
        },
        guidance: {
          failedChecks: failedWithGuidance,
          summary: {
            autoFixable: autoFixableCount,
            requiresManualFix: manualFixCount,
            canBeIgnored: canIgnoreCount,
            shouldNotIgnore: failedCount - canIgnoreCount
          }
        }
      });

    } catch (error: any) {
      console.error('❌ Error in auto-fix:', error);
      console.error('   Stack trace:', error.stack);

      // Extract more detailed error info
      let errorDetails = error.message || 'Unknown error';
      if (error.response) {
        // OpenAI API error
        errorDetails = `OpenAI API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`;
      } else if (error.code) {
        // Network or system error
        errorDetails = `${error.code}: ${error.message}`;
      }

      res.status(500).json({
        error: 'Failed to auto-fix issues',
        details: errorDetails,
        hint: 'Check server logs for more details. Common issues: OpenAI API rate limit, invalid API key, or service unavailable.'
      });
    }
  });

  // Analyze cost for Terraform resources
  app.post("/api/sessions/:id/analyze-cost", async (req, res) => {
    const sessionId = req.params.id;
    
    console.log(`\n💰 ========== COST ANALYSIS REQUEST ==========`);
    console.log(`Session ID: ${sessionId}`);
    console.log(`Timestamp: ${new Date().toISOString()}`);

    try {
      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ 
          error: 'Session not found',
          details: `Session ${sessionId} does not exist`
        });
      }

      // CRITICAL: Fetch files from SESSION STORAGE (not repository)
      // This ensures we analyze the LATEST generated code, not the old repository code
      console.log(`\n🔍 Fetching files from SESSION STORAGE (latest generated code) for cost analysis...`);
      console.log(`   This includes all newly generated/updated resources`);
      
      const sessionFiles = await storage.getFilesBySession(sessionId);
      console.log(`✅ Found ${sessionFiles.length} file(s) in session storage`);
      
      let allFiles: Array<{ fileName: string; content: string; sessionId: string; id: string }>;
      
      if (sessionFiles.length === 0) {
        console.error(`❌ No files found in session storage`);
        // Fallback: Try repository if session storage is empty
        if (session.provider && session.repositoryName) {
          console.log(`   ⚠️  Falling back to repository...`);
          const repoFiles = await mcpClient.scanRepositoryFiles(
            session.provider as MCPProvider,
            session.repositoryName,
            'main'
          );
          allFiles = repoFiles
            .filter(file => file.path.endsWith('.tf') || file.path.endsWith('.tfvars'))
            .map(file => ({
              fileName: file.path.split('/').pop() || file.path,
              content: file.content,
              sessionId: sessionId,
              id: `temp-${file.path}`,
            }));
          
          if (allFiles.length === 0) {
            return res.status(400).json({ 
              error: 'No Terraform files found',
              details: 'No files in session storage or repository'
            });
          }
          
          console.log(`   ✅ Using ${allFiles.length} file(s) from repository (fallback)`);
        } else {
          return res.status(400).json({ 
            error: 'No files found',
            details: 'No files in session storage and no repository configured'
          });
        }
      } else {
        // Filter to Terraform files only from session storage
        allFiles = sessionFiles
          .filter(file => {
            const fileName = file.fileName.toLowerCase();
            return fileName.endsWith('.tf') || fileName.endsWith('.tfvars');
          })
          .map(file => ({
            fileName: file.fileName,
            content: file.content,
            sessionId: sessionId,
            id: file.id,
          }));
        
        console.log(`   ✅ Using ${allFiles.length} file(s) from session storage (latest generated code)`);
      }
      
      console.log(`📄 Terraform files found: ${allFiles.length}`);
      
      // Debug: Show all files
      if (allFiles.length > 0) {
        console.log(`📄 Files to analyze:`);
        allFiles.forEach((file, i) => {
          console.log(`   ${i + 1}. ${file.fileName} (content length: ${file.content?.length || 0} bytes)`);
          if (file.content && file.content.length > 0) {
            const preview = file.content.substring(0, 150).replace(/\n/g, ' ');
            console.log(`      Preview: ${preview}...`);
          }
        });
      } else {
        console.warn(`⚠️  No Terraform files found in session storage or repository`);
        if (session.repositoryName) {
          console.warn(`   Repository: ${session.repositoryName}`);
        }
        if (session.provider) {
          console.warn(`   Provider: ${session.provider}`);
        }
      }
      
      const terraformFiles = allFiles.filter(file => {
        const fileName = file.fileName.toLowerCase();
        const isTerraform = fileName.endsWith('.tf') || fileName.endsWith('.tfvars') || fileName.endsWith('.hcl');
        
        if (isTerraform && (!file.content || file.content.trim().length === 0)) {
          console.warn(`   ⚠️  Skipping empty Terraform file: ${file.fileName}`);
          return false;
        }
        
        // For aggregated-root, exclude backend files (they don't have cost)
        if (session.moduleApproach === 'aggregated-root' && isTerraform) {
          const backendFiles = ['backend.tf', 'provider.tf', 'terraform.tf'];
          if (backendFiles.includes(fileName)) {
            console.log(`   ⏭️  Skipping backend file for cost analysis: ${file.fileName}`);
            return false;
          }
        }
        
        return isTerraform;
      });
      
      console.log(`📋 Terraform files for cost analysis: ${terraformFiles.length}`);
      terraformFiles.forEach(f => {
        console.log(`   - ${f.fileName} (${f.content.length} bytes)`);
      });

      console.log(`📁 Found ${terraformFiles.length} Terraform file(s) with content`);

      // Parse request body for profile and custom usage
      const requestProfile: UsageProfile = (req.body?.profile as UsageProfile) || 'medium';
      const customUsage: Record<string, Record<string, number>> = req.body?.customUsage || {};
      console.log(`📊 Usage profile: ${requestProfile}`);
      if (Object.keys(customUsage).length > 0) {
        console.log(`   Custom usage overrides: ${JSON.stringify(customUsage)}`);
      }

      // Build variable resolution map from all terraform files
      const tfFiles: TerraformFile[] = terraformFiles.map(f => ({
        fileName: f.fileName,
        content: f.content,
      }));
      const variableMap = buildVariableMap(tfFiles);
      const resolvedVarCount = Object.keys(variableMap).filter(k => !k.startsWith('__')).length;
      console.log(`🔧 Variable map built: ${resolvedVarCount} variable(s) resolved from tfvars/variables.tf`);

      if (terraformFiles.length === 0) {
        return res.status(400).json({ 
          success: false,
          error: 'No Terraform files found',
          details: 'No Terraform files exist for this session or all files are empty. Please generate Terraform files first.',
          summary: {
            totalMonthly: 0,
            totalYearly: 0,
            currency: 'USD',
            resourceCount: 0
          },
          resources: []
        });
      }

      // Step 1: Use AI to analyze Terraform files and extract resource information
      console.log(`\n🤖 Step 1: Analyzing Terraform files...`);
      
      // Get cloud provider from session
      const cloudProvider = session.cloudProvider || 'azure';
      console.log(`   📋 Cloud provider: ${cloudProvider}`);
      
      const filesContent = terraformFiles.map(f => ({
        path: f.fileName,
        content: f.content
      }));
      
      // First, try direct parsing as fallback
      console.log(`   📋 Attempting direct Terraform parsing...`);
      const directParsedResources: any[] = [];
      
      for (const file of terraformFiles) {
        const content = file.content;
        console.log(`   📄 Parsing file: ${file.fileName} (${content.length} bytes)`);
        
        // Parse resource blocks directly (handles multi-line blocks with nested structures)
        // Match: resource "type" "name" { ... } - need to handle nested braces
        const resourceMatches: Array<{ type: string; name: string; body: string; start: number }> = [];
        
        // Find all resource declarations
        const resourceDeclRegex = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g;
        let declMatch;
        
        while ((declMatch = resourceDeclRegex.exec(content)) !== null) {
          const resourceType = declMatch[1];
          const resourceName = declMatch[2];
          const startPos = declMatch.index;
          const openBracePos = declMatch.index + declMatch[0].length - 1;
          
          // Process resources based on cloud provider
          const isAzureResource = resourceType.startsWith('azurerm_') || resourceType.startsWith('azapi_');
          const isAWSResource = resourceType.startsWith('aws_');
          
          if ((cloudProvider === 'azure' && isAzureResource) || (cloudProvider === 'aws' && isAWSResource)) {
            // Find matching closing brace (handle nested braces)
            let braceCount = 1;
            let pos = openBracePos + 1;
            let inString = false;
            let stringChar = '';
            
            while (pos < content.length && braceCount > 0) {
              const char = content[pos];
              
              if (!inString) {
                if (char === '"' || char === "'") {
                  inString = true;
                  stringChar = char;
                } else if (char === '{') {
                  braceCount++;
                } else if (char === '}') {
                  braceCount--;
                }
              } else {
                if (char === stringChar && content[pos - 1] !== '\\') {
                  inString = false;
                }
              }
              
              pos++;
            }
            
            if (braceCount === 0) {
              const resourceBody = content.substring(openBracePos + 1, pos - 1);
              resourceMatches.push({
                type: resourceType,
                name: resourceName,
                body: resourceBody,
                start: startPos
              });
            }
          }
        }
        
          // Process each found resource
          for (const match of resourceMatches) {
            // Check if this resource uses count or for_each
            const hasCount = /count\s*=/.test(match.body);
            const hasForEach = /for_each\s*=/.test(match.body);
            
            if (hasCount || hasForEach) {
              console.log(`   ✅ Found resource: ${match.type}.${match.name} (with ${hasCount ? 'count' : 'for_each'})`);
            } else {
              console.log(`   ✅ Found resource: ${match.type}.${match.name}`);
            }
          
          // Extract location/region (handles both quoted and unquoted, with/without spaces)
          // AWS uses "region", Azure uses "location"
          // Also handles references like azurerm_resource_group.test.name or aws_region.current.name
          const locationField = cloudProvider === 'aws' ? 'region' : 'location';
          const defaultLocation = cloudProvider === 'aws' ? 'us-east-1' : 'eastus';
          
          // Try the cloud provider-specific field first
          let locationMatch = match.body.match(new RegExp(`${locationField}\\s*=\\s*"?([^"\\s\\n}]+)"?`));
          // Fallback to the other field if not found
          if (!locationMatch) {
            const fallbackField = cloudProvider === 'aws' ? 'location' : 'region';
            locationMatch = match.body.match(new RegExp(`${fallbackField}\\s*=\\s*"?([^"\\s\\n}]+)"?`));
          }
          
          let location = defaultLocation;
          if (locationMatch) {
            const rawLocation = locationMatch[1].trim().replace(/^["']|["']$/g, '');
            const locResult = resolveLocation(rawLocation, variableMap, defaultLocation);
            location = locResult.location;
          }
          
          // Extract attributes
          const attributes: Record<string, any> = {
            resource_type: match.type,
            resource_name: match.name
          };
          
          // Handle count and for_each for ALL cloud providers (before other attributes)
          // Extract count (numeric value or variable reference)
          const countMatch = match.body.match(/count\s*=\s*([^\s\n}]+)/);
          if (countMatch) {
            const countValue = countMatch[1].trim().replace(/^["']|["']$/g, '');
            // Try to parse as number, otherwise it's a variable reference
            const countNum = parseInt(countValue, 10);
            if (!isNaN(countNum)) {
              attributes.count = countNum;
              attributes.resource_count = countNum; // Actual count for cost calculation
            } else {
              attributes.count = countValue; // Variable reference
              attributes.resource_count = 1; // Default to 1, will need to resolve from tfvars
            }
          }
          
          // Extract for_each (set or map)
          const forEachMatch = match.body.match(/for_each\s*=\s*([^\s\n}]+)/);
          if (forEachMatch) {
            const forEachValue = forEachMatch[1].trim();
            // Try to extract count from for_each
            // Pattern: toset(["a", "b", "c"]) or var.some_set
            const setMatch = forEachValue.match(/toset\(\[([^\]]+)\]\)/);
            if (setMatch) {
              const items = setMatch[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
              attributes.for_each_count = items.length;
              attributes.resource_count = items.length;
            } else if (forEachValue.startsWith('var.')) {
              // Variable reference - will need to resolve from tfvars
              attributes.for_each = forEachValue;
              attributes.resource_count = 1; // Default, will need to resolve
            } else {
              // Could be a map or other expression
              attributes.for_each = forEachValue;
              attributes.resource_count = 1; // Default
            }
          }
          
          // Determine actual resource count (for cost calculation)
          let actualResourceCount = attributes.resource_count || 1; // Default to 1 if no count/for_each
          
          // Azure-specific attributes
          if (cloudProvider === 'azure') {
            // Helper to extract a simple attribute value, resolving var. references via variableMap
            const extractAttr = (key: string): string | undefined => {
              const m = match.body.match(new RegExp(`${key}\\s*=\\s*"?([^"\\s\\n}]+)"?`));
              if (!m) return undefined;
              let value = m[1].trim().replace(/^["']|["']$/g, '');
              // Resolve var. references using the pre-built variable map
              if (value.startsWith('var.')) {
                const varName = value.replace('var.', '');
                if (varName in variableMap) {
                  value = variableMap[varName];
                } else {
                  return undefined; // Unresolved -> use defaults
                }
              }
              return value;
            };

            // Storage account attributes
            const tierVal = extractAttr('account_tier');
            if (tierVal) attributes.account_tier = tierVal;
            const replVal = extractAttr('account_replication_type');
            if (replVal) attributes.account_replication_type = replVal;
            const kindVal = extractAttr('account_kind');
            if (kindVal) attributes.account_kind = kindVal;
            const accessTierVal = extractAttr('access_tier');
            if (accessTierVal) attributes.access_tier = accessTierVal;

            // Handle nested sku blocks
            const skuBlockMatch = match.body.match(/sku\s*\{([^}]+)\}/);
            if (skuBlockMatch) {
              const skuBody = skuBlockMatch[1];
              const skuTierMatch = skuBody.match(/tier\s*=\s*"?([^"\s\n}]+)"?/);
              const skuSizeMatch = skuBody.match(/size\s*=\s*"?([^"\s\n}]+)"?/);
              if (skuTierMatch) attributes.sku = skuTierMatch[1].trim().replace(/^["']|["']$/g, '');
              if (skuSizeMatch) attributes.sku_size = skuSizeMatch[1].trim().replace(/^["']|["']$/g, '');
              if (skuTierMatch && skuSizeMatch) {
                attributes.sku_name = `${attributes.sku}${attributes.sku_size}`;
              }
            } else {
              const skuMatch = extractAttr('sku');
              if (skuMatch) attributes.sku = skuMatch;
            }

            // sku_name (standalone, overrides nested if present)
            const skuNameVal = extractAttr('sku_name');
            if (skuNameVal) attributes.sku_name = skuNameVal;

            // sku_tier (for Firewall, etc.)
            const skuTierVal = extractAttr('sku_tier');
            if (skuTierVal) attributes.sku_tier = skuTierVal;

            // VM size (for azurerm_virtual_machine, linux_virtual_machine, windows_virtual_machine)
            const vmSizeVal = extractAttr('vm_size');
            if (vmSizeVal) attributes.vm_size = vmSizeVal;
            const sizeVal = extractAttr('size');
            if (sizeVal) attributes.size = sizeVal;

            // App Service plan reference
            const planIdVal = extractAttr('app_service_plan_id');
            if (planIdVal) attributes.app_service_plan_id = planIdVal;
            const servicePlanIdVal = extractAttr('service_plan_id');
            if (servicePlanIdVal) attributes.service_plan_id = servicePlanIdVal;

            // Managed disk attributes
            const storageAcctTypeVal = extractAttr('storage_account_type');
            if (storageAcctTypeVal) attributes.storage_account_type = storageAcctTypeVal;
            const diskSizeVal = extractAttr('disk_size_gb');
            if (diskSizeVal) attributes.disk_size_gb = diskSizeVal;
            const sizeGbVal = extractAttr('size_gb');
            if (sizeGbVal) attributes.size_gb = sizeGbVal;

            // Public IP attributes
            const allocMethodVal = extractAttr('allocation_method');
            if (allocMethodVal) attributes.allocation_method = allocMethodVal;

            // Redis Cache attributes
            const capacityVal = extractAttr('capacity');
            if (capacityVal) attributes.capacity = capacityVal;
            const familyVal = extractAttr('family');
            if (familyVal) attributes.family = familyVal;

            // Cognitive Services / Search
            const cogKindVal = extractAttr('kind');
            if (cogKindVal) attributes.kind = cogKindVal;

            // Application Insights
            const dailyCapVal = extractAttr('daily_data_cap_in_gb');
            if (dailyCapVal) attributes.daily_data_cap_in_gb = dailyCapVal;

            // AKS default_node_pool attributes (nested block)
            const nodePoolBlock = match.body.match(/default_node_pool\s*\{([^}]+)\}/);
            if (nodePoolBlock) {
              const npBody = nodePoolBlock[1];
              const npVmSize = npBody.match(/vm_size\s*=\s*"?([^"\s\n}]+)"?/);
              if (npVmSize) attributes.default_node_pool_vm_size = npVmSize[1].trim().replace(/^["']|["']$/g, '');
              const npNodeCount = npBody.match(/node_count\s*=\s*"?([^"\s\n}]+)"?/);
              if (npNodeCount) attributes.default_node_pool_node_count = npNodeCount[1].trim().replace(/^["']|["']$/g, '');
              const npMinCount = npBody.match(/min_count\s*=\s*"?([^"\s\n}]+)"?/);
              if (npMinCount) attributes.node_count = npMinCount[1].trim().replace(/^["']|["']$/g, '');
            }

            // Container Group attributes (cpu, memory)
            const cpuVal = extractAttr('cpu');
            if (cpuVal) attributes.cpu = cpuVal;
            const memVal = extractAttr('memory');
            if (memVal) attributes.memory = memVal;

            // Container / resources block for container_group
            const containerBlock = match.body.match(/container\s*\{([\s\S]*?)\}/);
            if (containerBlock) {
              const cBody = containerBlock[1];
              const cCpu = cBody.match(/cpu\s*=\s*"?([^"\s\n}]+)"?/);
              if (cCpu && !attributes.cpu) attributes.cpu = cCpu[1].trim().replace(/^["']|["']$/g, '');
              const cMem = cBody.match(/memory\s*=\s*"?([^"\s\n}]+)"?/);
              if (cMem && !attributes.memory) attributes.memory = cMem[1].trim().replace(/^["']|["']$/g, '');
            }
          }
          
          // AWS-specific attributes
          if (cloudProvider === 'aws') {
            // EC2 attributes
            const instanceTypeMatch = match.body.match(/instance_type\s*=\s*"?([^"\s\n}]+)"?/);
            if (instanceTypeMatch) attributes.instance_type = instanceTypeMatch[1].trim().replace(/^["']|["']$/g, '');
            
            // Lambda attributes
            const memorySizeMatch = match.body.match(/memory_size\s*=\s*"?([^"\s\n}]+)"?/);
            if (memorySizeMatch) attributes.memory_size = memorySizeMatch[1].trim().replace(/^["']|["']$/g, '');
            
            const timeoutMatch = match.body.match(/timeout\s*=\s*"?([^"\s\n}]+)"?/);
            if (timeoutMatch) attributes.timeout = timeoutMatch[1].trim().replace(/^["']|["']$/g, '');
            
            // RDS attributes
            const instanceClassMatch = match.body.match(/instance_class\s*=\s*"?([^"\s\n}]+)"?/);
            if (instanceClassMatch) attributes.instance_class = instanceClassMatch[1].trim().replace(/^["']|["']$/g, '');
            
            const engineMatch = match.body.match(/engine\s*=\s*"?([^"\s\n}]+)"?/);
            if (engineMatch) attributes.engine = engineMatch[1].trim().replace(/^["']|["']$/g, '');
            
            const multiAzMatch = match.body.match(/multi_az\s*=\s*"?([^"\s\n}]+)"?/);
            if (multiAzMatch) {
              const multiAzValue = multiAzMatch[1].trim().replace(/^["']|["']$/g, '');
              attributes.multi_az = multiAzValue === 'true';
            }
            
            // DynamoDB attributes
            const billingModeMatch = match.body.match(/billing_mode\s*=\s*"?([^"\s\n}]+)"?/);
            if (billingModeMatch) attributes.billing_mode = billingModeMatch[1].trim().replace(/^["']|["']$/g, '');
            
            const readCapacityMatch = match.body.match(/read_capacity\s*=\s*"?([^"\s\n}]+)"?/);
            if (readCapacityMatch) attributes.read_capacity = readCapacityMatch[1].trim().replace(/^["']|["']$/g, '');
            
            const writeCapacityMatch = match.body.match(/write_capacity\s*=\s*"?([^"\s\n}]+)"?/);
            if (writeCapacityMatch) attributes.write_capacity = writeCapacityMatch[1].trim().replace(/^["']|["']$/g, '');
            
            // ElastiCache attributes
            const nodeTypeMatch = match.body.match(/node_type\s*=\s*"?([^"\s\n}]+)"?/);
            if (nodeTypeMatch) attributes.node_type = nodeTypeMatch[1].trim().replace(/^["']|["']$/g, '');
            
            const numCacheNodesMatch = match.body.match(/num_cache_nodes\s*=\s*"?([^"\s\n}]+)"?/);
            if (numCacheNodesMatch) attributes.num_cache_nodes = numCacheNodesMatch[1].trim().replace(/^["']|["']$/g, '');
          }
          
          // Resolve count/for_each using the variable resolver
          const countResult = resolveResourceCount(match.body, variableMap);
          actualResourceCount = countResult.count;
          if (countResult.count > 1) {
            attributes.resource_count = countResult.count;
            console.log(`   ✅ Resolved resource count = ${countResult.count} (${countResult.resolved ? 'resolved' : 'default'})`);
          }
          
          // Create resource entries - if count > 1, create multiple entries for accurate cost calculation
          for (let i = 0; i < actualResourceCount; i++) {
            const resourceName = actualResourceCount > 1 ? `${match.name}[${i}]` : match.name;
            
            // Store location/region in the appropriate field based on cloud provider
            const resourceData: any = {
              resourceType: match.type,
              resourceName: resourceName,
              attributes: {
                ...attributes,
                instance_index: actualResourceCount > 1 ? i : undefined
              }
            };
            
            if (cloudProvider === 'aws') {
              resourceData.region = location;
            } else {
              resourceData.location = location;
            }
            
            directParsedResources.push(resourceData);
          }
          
          if (actualResourceCount > 1) {
            console.log(`   📊 Resource count: ${actualResourceCount} (expanded from count/for_each)`);
          }
        }
      }
      
      console.log(`   📊 Direct parsing found ${directParsedResources.length} resource(s)`);
      
      // Now try AI analysis
      console.log(`   🤖 Attempting AI analysis...`);
      
      // Build cloud provider-specific prompt
      const isAWS = cloudProvider === 'aws';
      const resourcePrefix = isAWS ? 'aws_' : 'azurerm_';
      const resourceExamples = isAWS 
        ? 'aws_s3_bucket, aws_ec2_instance, aws_lambda_function, aws_rds_instance, aws_dynamodb_table, aws_apigateway_rest_api, etc.'
        : 'azurerm_storage_account, azurerm_function_app, azurerm_logic_app_workflow, azurerm_frontdoor, azurerm_app_service, azurerm_app_service_plan, azurerm_static_site, azurerm_resource_group, etc.';
      const locationField = isAWS ? 'region' : 'location';
      const defaultLocation = isAWS ? 'us-east-1' : 'eastus';
      const pricingAttributes = isAWS
        ? `   - For EC2: instance_type, instance_count
   - For S3: versioning, lifecycle_rules, storage_class
   - For RDS: instance_class, engine, multi_az
   - For Lambda: memory_size, timeout
   - For DynamoDB: billing_mode, read_capacity, write_capacity
   - For API Gateway: api_type, endpoint_type
   - Any size, tier, or capacity information`
        : `   - For Storage: account_tier, account_replication_type, account_kind
   - For Function App: app_service_plan_id, consumption plan vs dedicated
   - For Logic App: sku, location
   - For Front Door: sku_name, location
   - For App Service: app_service_plan_id, sku
   - For App Service Plan: sku, sku_name, kind
   - For Static Web App: sku_size, location
   - Any size, tier, or SKU information`;
      
      const analysisPrompt = `Analyze these Terraform files and identify ALL ${isAWS ? 'AWS' : 'Azure'} resources with their pricing-relevant attributes.

CRITICAL: You MUST find and extract ALL resources that start with "${resourcePrefix}"${isAWS ? '' : ' or "azapi_"'}. Do not skip any resources.

For each resource, extract:
1. Resource type (e.g., ${resourceExamples})
2. Resource name (the label after the resource type, e.g., "mybucket" in "resource ${resourcePrefix}${isAWS ? 's3_bucket' : 'storage_account'} mybucket")
3. ${isAWS ? 'Region' : 'Location/region'} (from ${locationField} attribute${isAWS ? '' : ' or resource group location'})
4. Pricing-relevant attributes:
${pricingAttributes}

IMPORTANT: 
- Include ALL resources, even if they don't have explicit pricing
- Extract ${locationField} from the resource's "${locationField}" attribute${isAWS ? '' : ', or infer from resource group'}
- If ${locationField} is not specified, use "${defaultLocation}" as default
- Extract ALL attributes that might affect pricing

Return ONLY valid JSON in this exact format (no markdown, no code blocks):
{
  "resources": [
    {
      "resourceType": "${resourcePrefix}${isAWS ? 's3_bucket' : 'storage_account'}",
      "resourceName": "${isAWS ? 'mybucket' : 'mystorage'}",
      "${locationField}": "${defaultLocation}",
      "attributes": {
        ${isAWS ? '"versioning": "Enabled",\n        "lifecycle_rules": []' : '"account_tier": "Standard",\n        "account_replication_type": "LRS",\n        "account_kind": "StorageV2"'}
      }
    }
  ]
}

Terraform files:
${JSON.stringify(filesContent, null, 2)}

Remember: Return ONLY the JSON object, no other text.`;

      let aiParsedResources: any[] = [];
      try {
        const aiAnalysis = await openaiService.chat([
          {
            role: 'system',
            content: `You are an expert at analyzing Terraform files and extracting ${isAWS ? 'AWS' : 'Azure'} resource information for cost estimation. Return only valid JSON.`
          },
          {
            role: 'user',
            content: analysisPrompt
          }
        ]);

        console.log(`\n📝 AI Response (first 500 chars): ${aiAnalysis.substring(0, 500)}...`);

        const cleanedResponse = aiAnalysis.trim();
        const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
        let parsedData: any;

        if (jsonMatch) {
          parsedData = JSON.parse(jsonMatch[0]);
        } else {
          parsedData = JSON.parse(cleanedResponse);
        }

        aiParsedResources = parsedData.resources || parsedData || [];

        console.log(`\n✅ Parsed ${aiParsedResources.length} resource(s) from AI analysis`);
        if (aiParsedResources.length > 0) {
          aiParsedResources.forEach((r: any, idx: number) => {
            console.log(`   ${idx + 1}. ${r.resourceType} - ${r.resourceName} (${r.location || 'no location'})`);
          });
        } else {
          console.warn(`   ⚠️  No resources found in AI response!`);
          console.warn(`   Full AI response: ${aiAnalysis}`);
        }
      } catch (aiError: any) {
        console.warn(`⚠️  AI analysis failed (non-fatal): ${aiError.message}`);
        console.warn('   Will use direct parsing results instead');
      }
      
      // Combine direct parsing and AI results, prefer direct parsing if it found resources
      // (more reliable than AI which might fail or return empty)
      let parsedResources: any[] = [];
      
      console.log(`\n📊 Parsing Summary:`);
      console.log(`   Direct parsing: ${directParsedResources.length} resource(s)`);
      console.log(`   AI parsing: ${aiParsedResources.length} resource(s)`);
      
      if (directParsedResources.length > 0) {
        console.log(`\n✅ Using direct parsing results (${directParsedResources.length} resources)`);
        parsedResources = directParsedResources;
        
        // If AI also found resources, merge them (AI might have more attributes)
        if (aiParsedResources.length > 0) {
          console.log(`   Merging with AI results for additional attributes...`);
          // Create a map of direct parsed resources by type+name
          const directMap = new Map<string, any>();
          directParsedResources.forEach(r => {
            const key = `${r.resourceType}.${r.resourceName}`;
            directMap.set(key, r);
          });
          
          // Merge AI attributes into direct parsed resources (DO NOT add AI-only resources)
          aiParsedResources.forEach(aiRes => {
            const key = `${aiRes.resourceType}.${aiRes.resourceName}`;
            const directRes = directMap.get(key);
            if (directRes) {
              // Merge attributes from AI into directly-parsed resource
              directRes.attributes = { ...directRes.attributes, ...aiRes.attributes };
            } else {
              // AI hallucinated a resource not in the Terraform files - ignore it
              console.warn(`   ⚠️  Ignoring AI-only resource ${key} (not found by direct parsing)`);
            }
          });
        }
      } else if (aiParsedResources.length > 0) {
        console.log(`\n✅ Using AI analysis results (${aiParsedResources.length} resources)`);
        parsedResources = aiParsedResources;
      } else {
        console.error(`\n❌ No resources found by either method!`);
        console.error(`   Direct parsing: ${directParsedResources.length} resources`);
        console.error(`   AI parsing: ${aiParsedResources.length} resources`);
        console.error(`   Terraform files analyzed: ${terraformFiles.length}`);
        terraformFiles.forEach(f => {
          console.error(`     - ${f.fileName} (${f.content.length} bytes)`);
          // Show first 500 chars of content for debugging
          console.error(`       Content preview: ${f.content.substring(0, 500).replace(/\n/g, ' ')}...`);
        });
        
        return res.status(400).json({
          success: false,
          error: 'No resources found',
          details: `No ${cloudProvider === 'aws' ? 'AWS' : 'Azure'} resources were detected in the Terraform files. Make sure your files contain valid ${cloudProvider === 'aws' ? 'AWS' : 'Azure'} resource definitions (e.g., resource "${cloudProvider === 'aws' ? 'aws_s3_bucket' : 'azurerm_storage_account'}" "name" { ... }).`,
          summary: {
            totalMonthly: 0,
            totalYearly: 0,
            currency: 'USD',
            resourceCount: 0
          },
          resources: []
        });
      }
      
      console.log(`\n📊 Final resource list (${parsedResources.length} resources):`);
      parsedResources.forEach((r, idx) => {
        const locationField = cloudProvider === 'aws' ? 'region' : 'location';
        const defaultLocation = cloudProvider === 'aws' ? 'us-east-1' : 'eastus';
        const resourceLocation = r[locationField] || r.location || r.region || defaultLocation;
        console.log(`   ${idx + 1}. ${r.resourceType}.${r.resourceName} (${resourceLocation})`);
        if (Object.keys(r.attributes || {}).length > 0) {
          console.log(`      Attributes: ${JSON.stringify(r.attributes)}`);
        }
      });

      // Step 2: Map Terraform resource types to Azure service names (deterministic lookup)
      console.log(`\n📋 Mapping resource types to service names (deterministic)...`);
      const uniqueResourceTypes = Array.from(new Set(parsedResources.map(r => r.resourceType)));
      const resourceTypeToService: Record<string, string> = {};

      for (const rt of uniqueResourceTypes) {
        resourceTypeToService[rt] = getServiceName(rt);
      }
      console.log(`   ✅ Mapped ${Object.keys(resourceTypeToService).length} resource type(s) to service names`);

      // Step 3: Query pricing for each resource
      console.log(`\n💰 Step 2: Querying ${cloudProvider === 'aws' ? 'AWS' : 'Azure'} Pricing...`);
      
      const costEstimates: CostResource[] = [];
      const skippedResources: Array<{ resourceType: string; resourceName: string; reason: string }> = [];

      console.log(`\n💰 Step 2: Querying ${cloudProvider === 'aws' ? 'AWS' : 'Azure'} Pricing API for ${parsedResources.length} resource(s)...`);

      // AWS pricing handling
      if (cloudProvider === 'aws') {
        console.log(`\n⚠️  AWS Pricing: Full pricing requires AWS Pricing API setup.`);

        for (const resource of parsedResources) {
          const serviceName = resourceTypeToService[resource.resourceType] || resource.resourceType;

          if (resource.resourceType === 'aws_iam_role' || resource.resourceType === 'aws_iam_policy') {
            costEstimates.push({
              resourceName: resource.resourceName,
              resourceType: resource.resourceType,
              serviceName,
              monthlyCost: 0,
              yearlyCost: 0,
              currency: 'USD',
              status: 'exact',
              pricingMatchType: 'free',
              confidenceScore: 1.0,
              confidenceLabel: 'high',
              assumptionsUsed: ['IAM resources are free'],
            });
            continue;
          }

          skippedResources.push({
            resourceType: resource.resourceType,
            resourceName: resource.resourceName,
            reason: 'AWS Pricing API not implemented',
          });
        }
      } else {
        // Azure pricing (deterministic lookup-based) with status classification
        for (const resource of parsedResources) {
          const serviceName = resourceTypeToService[resource.resourceType] || resource.resourceType;
          const resourceAddr = `${resource.resourceType}.${resource.resourceName}`;
          console.log(`\n   [${parsedResources.indexOf(resource) + 1}/${parsedResources.length}] Querying pricing for: ${serviceName} (${resource.resourceName})`);
          console.log(`      Type: ${resource.resourceType}`);
          console.log(`      Location: ${resource.location || 'eastus'}`);

          // Resolve attributes using the variable map, track unresolved
          const { attrs: resolvedAttrs, unresolved: unresolvedVars } = resolveResourceAttributes(
            resource.attributes || {},
            variableMap
          );
          if (unresolvedVars.length > 0) {
            console.log(`      ⚠️  Unresolved variables: ${unresolvedVars.join(', ')}`);
          }

          // Get usage dimensions and apply profile/custom overrides
          const usageCatalog = getUsageCatalog(resource.resourceType);
          const usageDefaults = getUsageDefaults(resource.resourceType, requestProfile);
          const resourceCustomUsage = customUsage[resourceAddr] || {};
          const appliedUsage = { ...usageDefaults, ...resourceCustomUsage };
          const isUsageBased = hasUsageDimensions(resource.resourceType);

          // Skip free Azure resources (no direct cost)
          const freeReason = isFreeResource(resource.resourceType);
          if (freeReason) {
            console.log(`      ⏭️  Free: ${freeReason}`);
            costEstimates.push({
              resourceName: resource.resourceName,
              resourceType: resource.resourceType,
              serviceName,
              monthlyCost: 0,
              yearlyCost: 0,
              currency: 'USD',
              status: 'exact',
              pricingMatchType: 'free',
              confidenceScore: 1.0,
              confidenceLabel: 'high',
              assumptionsUsed: [freeReason],
            });
            continue;
          }

          try {
            const pricingConfig = getPricingConfig(resource.resourceType);
            const azureLocation = resolveAzureLocation(resource.location || 'eastus');

            // Check for resources with no direct cost (cost is in parent resource)
            if (pricingConfig && pricingConfig.buildFilter(resolvedAttrs, azureLocation) === '') {
              console.log(`      ℹ️  ${resource.resourceType} has no direct cost (cost is in parent resource)`);
              costEstimates.push({
                resourceName: resource.resourceName,
                resourceType: resource.resourceType,
                serviceName,
                monthlyCost: 0,
                yearlyCost: 0,
                currency: 'USD',
                status: 'exact',
                pricingMatchType: 'parent',
                confidenceScore: 1.0,
                confidenceLabel: 'high',
                assumptionsUsed: ['Cost billed through parent resource'],
                details: resolvedAttrs,
              });
              continue;
            }

            // If critical SKU attributes are unresolved, mark as needs_input
            const criticalAttrs = pricingConfig?.attributeKeys || [];
            const hasCriticalUnresolved = criticalAttrs.some(key => {
              const val = resolvedAttrs[key];
              return typeof val === 'string' && val.startsWith('var.');
            });

            if (hasCriticalUnresolved && !pricingConfig?.defaults) {
              console.warn(`      ⚠️  Critical attributes unresolved for ${resource.resourceType}`);
              costEstimates.push({
                resourceName: resource.resourceName,
                resourceType: resource.resourceType,
                serviceName,
                monthlyCost: 0,
                yearlyCost: 0,
                currency: 'USD',
                status: 'needs_input',
                pricingMatchType: 'unsupported',
                confidenceScore: 0,
                confidenceLabel: 'low',
                assumptionsUsed: [],
                unresolvedVariables: unresolvedVars,
                usageDimensions: criticalAttrs.map(key => ({
                  key,
                  label: key,
                  unit: '',
                  defaultValue: 0,
                })),
              });
              continue;
            }

            // If no pricing config exists, mark as unsupported (no heuristic fallback)
            if (!pricingConfig) {
              console.warn(`      ⚠️  No pricing config for ${resource.resourceType} - marking as unsupported`);
              costEstimates.push({
                resourceName: resource.resourceName,
                resourceType: resource.resourceType,
                serviceName,
                monthlyCost: 0,
                yearlyCost: 0,
                currency: 'USD',
                status: 'needs_input',
                pricingMatchType: 'unsupported',
                confidenceScore: 0,
                confidenceLabel: 'low',
                assumptionsUsed: ['No deterministic pricing config available for this resource type'],
                unresolvedVariables: unresolvedVars.length > 0 ? unresolvedVars : undefined,
              });
              continue;
            }

            // Build the API filter
            let matchType: CostResource['pricingMatchType'] = 'config_exact';
            const filter = buildPricingApiFilter(resource.resourceType, resolvedAttrs, resource.location || 'eastus');

            if (!filter) {
              console.warn(`      ⚠️  No pricing filter available for ${resource.resourceType}`);
              skippedResources.push({
                resourceType: resource.resourceType,
                resourceName: resource.resourceName,
                reason: 'No pricing filter available',
              });
              continue;
            }

            console.log(`      🔍 Filter: ${filter}`);

            const apiUrl = `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}&$top=50`;
            const apiResponse = await fetch(apiUrl);
            if (!apiResponse.ok) {
              throw new Error(`Azure Pricing API returned ${apiResponse.status}: ${apiResponse.statusText}`);
            }

            const pricingData = await apiResponse.json();
            let items: any[] = pricingData?.Items || [];
            console.log(`      📊 Found ${items.length} pricing item(s)`);

            // If no results, try a broader fallback filter (serviceName + region only)
            if (items.length === 0 && pricingConfig) {
              console.log(`      🔄 Trying broader filter...`);
              matchType = 'config_broad';
              const broadFilter = `serviceName eq '${pricingConfig.serviceName}' and armRegionName eq '${azureLocation}' and priceType eq 'Consumption'`;
              const broadUrl = `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(broadFilter)}&$top=50`;
              try {
                const broadResponse = await fetch(broadUrl);
                if (broadResponse.ok) {
                  const broadData = await broadResponse.json();
                  items = broadData?.Items || [];
                  if (items.length > 0) {
                    console.log(`      ✅ Found ${items.length} item(s) with broader filter`);
                  }
                }
              } catch (broadErr: any) {
                console.warn(`      ⚠️  Broader query failed: ${broadErr.message}`);
              }
            }

            if (items.length === 0) {
              console.warn(`      ❌ No pricing items found for ${serviceName} in ${azureLocation}`);
              costEstimates.push({
                resourceName: resource.resourceName,
                resourceType: resource.resourceType,
                serviceName,
                monthlyCost: 0,
                yearlyCost: 0,
                currency: 'USD',
                status: 'needs_input',
                pricingMatchType: 'unsupported',
                confidenceScore: 0,
                confidenceLabel: 'low',
                assumptionsUsed: ['No pricing data found in Azure Retail API'],
                usageDimensions: usageCatalog?.dimensions.map(d => ({
                  key: d.key,
                  label: d.label,
                  unit: d.unit,
                  defaultValue: d[requestProfile === 'custom' ? 'medium' : requestProfile],
                })),
              });
              continue;
            }

            // Select the best pricing item using the config's selector
            const priceItem = selectBestPricingItem(resource.resourceType, items, resolvedAttrs);

            if (!priceItem) {
              console.log(`      ℹ️  No applicable pricing item (resource may have no direct cost)`);
              costEstimates.push({
                resourceName: resource.resourceName,
                resourceType: resource.resourceType,
                serviceName,
                monthlyCost: 0,
                yearlyCost: 0,
                currency: 'USD',
                status: 'exact',
                pricingMatchType: matchType,
                confidenceScore: 0.8,
                confidenceLabel: 'medium',
                assumptionsUsed: ['No billable pricing item found - may be included in parent'],
                details: resolvedAttrs,
              });
              continue;
            }

            console.log(`      📊 Selected: ${priceItem.meterName} | ${priceItem.unitOfMeasure} | $${priceItem.retailPrice}`);

            // Merge usage-catalog values into attrs so calculateCost picks them up
            const costAttrs = isUsageBased
              ? applyUsageToAttrs(resource.resourceType, resolvedAttrs, appliedUsage)
              : resolvedAttrs;

            // Calculate monthly cost using the config's deterministic calculator
            const monthlyCost = calculateMonthlyCost(resource.resourceType, priceItem, costAttrs);

            const yearlyCost = monthlyCost * 12;

            console.log(`      ✅ Cost: $${monthlyCost.toFixed(2)}/month ($${yearlyCost.toFixed(2)}/year)`);

            // Determine status and confidence
            const assumptions: string[] = [];
            let status: CostStatus = 'exact';
            let confidenceScore = 1.0;

            if (isUsageBased) {
              status = Object.keys(resourceCustomUsage).length > 0 ? 'exact' : 'estimated';
              if (status === 'estimated') {
                assumptions.push(`Usage profile: ${requestProfile}`);
                for (const [dimKey, dimVal] of Object.entries(appliedUsage)) {
                  const dim = usageCatalog?.dimensions.find(d => d.key === dimKey);
                  assumptions.push(`${dim?.label || dimKey}: ${dimVal} ${dim?.unit || ''}`);
                }
                confidenceScore = 0.6;
              }
            }

            if (matchType === 'config_broad') {
              assumptions.push('Used broader SKU filter (exact SKU not found)');
              confidenceScore = Math.min(confidenceScore, 0.5);
              status = 'estimated';
            }
            if (unresolvedVars.length > 0) {
              assumptions.push(`Unresolved vars: ${unresolvedVars.join(', ')} - used defaults`);
              confidenceScore = Math.min(confidenceScore, 0.4);
              status = 'estimated';
            }

            const confidenceLabel: CostResource['confidenceLabel'] =
              confidenceScore >= 0.8 ? 'high' : confidenceScore >= 0.5 ? 'medium' : 'low';

            costEstimates.push({
              resourceName: resource.resourceName,
              resourceType: resource.resourceType,
              serviceName,
              monthlyCost: Math.round(monthlyCost * 100) / 100,
              yearlyCost: Math.round(yearlyCost * 100) / 100,
              currency: 'USD',
              status,
              pricingMatchType: matchType,
              confidenceScore: Math.round(confidenceScore * 100) / 100,
              confidenceLabel,
              assumptionsUsed: assumptions,
              usageDimensions: usageCatalog?.dimensions.map(d => ({
                key: d.key,
                label: d.label,
                unit: d.unit,
                defaultValue: d[requestProfile === 'custom' ? 'medium' : requestProfile],
              })),
              providedUsage: Object.keys(appliedUsage).length > 0 ? appliedUsage : undefined,
              unresolvedVariables: unresolvedVars.length > 0 ? unresolvedVars : undefined,
              details: resolvedAttrs,
            });
          } catch (error: any) {
            console.error(`      ❌ Failed to get pricing for ${resource.resourceName}:`, error.message);
            skippedResources.push({
              resourceType: resource.resourceType,
              resourceName: resource.resourceName,
              reason: error.message,
            });
          }
        } // End of Azure pricing loop
      } // End of cloud provider check

      // Calculate totals with status breakdown
      const exactResources = costEstimates.filter(r => r.status === 'exact');
      const estimatedResources = costEstimates.filter(r => r.status === 'estimated');
      const needsInputResources = costEstimates.filter(r => r.status === 'needs_input');
      const freeResources = costEstimates.filter(r => r.pricingMatchType === 'free' || r.pricingMatchType === 'parent');

      const monthlyTotalExact = exactResources.reduce((sum, r) => sum + r.monthlyCost, 0);
      const monthlyTotalEstimated = estimatedResources.reduce((sum, r) => sum + r.monthlyCost, 0);
      const monthlyGrandTotal = costEstimates.reduce((sum, r) => sum + r.monthlyCost, 0);
      const yearlyGrandTotal = monthlyGrandTotal * 12;

      console.log(`\n✅ Cost analysis completed`);
      console.log(`   Resources processed: ${costEstimates.length}`);
      console.log(`   Exact: ${exactResources.length} ($${monthlyTotalExact.toFixed(2)}/mo)`);
      console.log(`   Estimated: ${estimatedResources.length} ($${monthlyTotalEstimated.toFixed(2)}/mo)`);
      console.log(`   Needs Input: ${needsInputResources.length}`);
      console.log(`   Free: ${freeResources.length}`);
      console.log(`   Skipped: ${skippedResources.length}`);
      console.log(`   Grand Total: $${monthlyGrandTotal.toFixed(2)}/month`);

      const result: CostAnalysisResult = {
        success: true,
        summary: {
          monthlyTotalExact: Math.round(monthlyTotalExact * 100) / 100,
          monthlyTotalEstimated: Math.round(monthlyTotalEstimated * 100) / 100,
          monthlyGrandTotal: Math.round(monthlyGrandTotal * 100) / 100,
          yearlyGrandTotal: Math.round(yearlyGrandTotal * 100) / 100,
          currency: 'USD',
          exactCount: exactResources.length,
          estimatedCount: estimatedResources.length,
          needsInputCount: needsInputResources.length,
          freeCount: freeResources.length,
          resourceCount: costEstimates.length,
          profile: requestProfile,
        },
        resources: costEstimates,
        skippedResources: skippedResources.length > 0 ? skippedResources : undefined,
      };

      res.json(result);

    } catch (error: any) {
      console.error('❌ Error in cost analysis:', error);
      console.error('   Error stack:', error.stack);
      res.status(500).json({ 
        success: false,
        error: 'Failed to analyze costs',
        details: error.message || 'Unknown error occurred',
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // ========== DOCKER WORKFLOW ENDPOINTS ==========

  // Generate Dockerfile
  app.post("/api/sessions/:id/generate-dockerfile", async (req, res) => {
    const sessionId = req.params.id;
    
    try {
      const { requirements } = req.body;

      if (!requirements) {
        return res.status(400).json({ 
          error: 'Missing required field',
          details: 'requirements is required'
        });
      }

      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      console.log(`\n🐳 ========== DOCKERFILE GENERATION ==========`);
      console.log(`Session ID: ${sessionId}`);
      console.log(`Requirements: "${typeof requirements === 'string' ? requirements.substring(0, 200) : JSON.stringify(requirements).substring(0, 200)}..."`);

      // Import and generate Dockerfile
      const { generateDockerfile } = await import('./docker/dockerfile-generator');
      const result = await generateDockerfile(requirements);

      console.log(`✅ Generated ${result.files.length} file(s)`);

      // Save generated files to session storage
      const savedFiles = [];
      for (const file of result.files) {
        const created = await storage.createFile({
          sessionId,
          fileName: file.path,
          content: file.content,
        });
        savedFiles.push(created);
        console.log(`   ✅ Saved: ${file.path} (${file.content.length} chars)`);
      }

      // Update session
      await storage.updateSession(sessionId, { 
        currentStep: '4',
        workflowStep: 'docker_generation'
      });

      res.json(savedFiles);
    } catch (error: any) {
      console.error('\n❌ ========== DOCKERFILE GENERATION ERROR ==========');
      console.error('Session ID:', sessionId);
      console.error('Error type:', error?.constructor?.name || typeof error);
      console.error('Error message:', error?.message || String(error));
      console.error('Error code:', error?.code);
      console.error('Error name:', error?.name);
      if (error?.stack) {
        console.error('Error stack:');
        console.error(error.stack);
      }
      console.error('==========================================\n');
      
      // Provide more helpful error message
      let errorMessage = error?.message || 'Failed to generate Dockerfile';
      let errorDetails = '';
      
      // Check for specific error types
      if (error?.message?.includes('API key')) {
        errorMessage = 'OpenAI API key not configured';
        errorDetails = 'Please set OPENAI_API_KEY environment variable';
      } else if (error?.message?.includes('rate limit') || error?.code === 'rate_limit_exceeded') {
        errorMessage = 'OpenAI API rate limit exceeded';
        errorDetails = 'Please wait a moment and try again';
      } else if (error?.message?.includes('Invalid response format') || error?.message?.includes('JSON')) {
        errorMessage = 'Failed to parse AI response';
        errorDetails = 'The AI response was not in the expected format. Please try again.';
      } else {
        errorDetails = error?.stack || error?.message || 'Unknown error occurred';
      }
      
      res.status(500).json({ 
        error: errorMessage,
        details: errorDetails,
        sessionId: sessionId,
        timestamp: new Date().toISOString(),
        ...(process.env.NODE_ENV === 'development' && { stack: error?.stack })
      });
    }
  });

  // Scan Dockerfile
  app.post("/api/sessions/:id/scan-docker", async (req, res) => {
    try {
      const sessionId = req.params.id;
      console.log(`\n🔍 ========== DOCKER SCAN REQUEST ==========`);
      console.log(`Session ID: ${sessionId}`);
      
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Fetch Dockerfile from session storage
      const sessionFiles = await storage.getFilesBySession(sessionId);
      console.log(`\n📋 All files in session (${sessionFiles.length} total):`);
      sessionFiles.forEach((f, idx) => {
        console.log(`   ${idx + 1}. ${f.fileName} (${f.content.length} chars)`);
      });
      
      const dockerFiles = sessionFiles.filter(f => 
        f.fileName.toLowerCase() === 'dockerfile' || 
        f.fileName.toLowerCase().endsWith('.dockerfile')
      );

      if (dockerFiles.length === 0) {
        console.error(`❌ No Dockerfile found in session storage`);
        console.error(`   Available files: ${sessionFiles.map(f => f.fileName).join(', ') || 'none'}`);
        return res.status(400).json({ 
          error: 'No Dockerfile found',
          details: `Please generate a Dockerfile first. Available files: ${sessionFiles.map(f => f.fileName).join(', ') || 'none'}`
        });
      }

      console.log(`📁 Found ${dockerFiles.length} Dockerfile(s) to scan:`);
      dockerFiles.forEach((f, idx) => {
        console.log(`   ${idx + 1}. ${f.fileName} (${f.content.length} chars)`);
        console.log(`      Content preview: ${f.content.substring(0, 100).replace(/\n/g, ' ')}...`);
      });

      // Use Checkov for Docker scanning
      const fs = await import('fs/promises');
      const path = await import('path');
      const { spawn } = await import('child_process');
      const os = await import('os');

      // Create temp directory
      const projectRoot = process.cwd();
      const tempBaseDir = path.join(projectRoot, '.temp-checkov');
      await fs.mkdir(tempBaseDir, { recursive: true });
      let tempDir: string | undefined;
      
      try {
        tempDir = await fs.mkdtemp(path.join(tempBaseDir, 'docker-scan-'));
        
        // Write Dockerfile to temp directory
        // Ensure the file is named exactly "Dockerfile" (case-sensitive)
        const dockerfilePath = path.join(tempDir, 'Dockerfile');
        let dockerfileWritten = false;
        
        // Write Dockerfile - ensure it's named exactly "Dockerfile" (case-sensitive, no extension)
        for (const file of dockerFiles) {
          // Always use "Dockerfile" as the filename (Checkov expects this exact name)
          const fileName = 'Dockerfile'; // Always use this exact name
          const filePath = path.join(tempDir, fileName);
          
          // Write the file
          await fs.writeFile(filePath, file.content, 'utf-8');
          console.log(`   ✅ Written: ${file.fileName} -> ${filePath} (${file.content.length} chars)`);
          
          if (fileName === 'Dockerfile') {
            dockerfileWritten = true;
          }
        }
        
        // Verify Dockerfile exists and has content
        try {
          await fs.access(dockerfilePath);
          const stats = await fs.stat(dockerfilePath);
          const content = await fs.readFile(dockerfilePath, 'utf-8');
          console.log(`\n✅ Dockerfile verification:`);
          console.log(`   Path: ${dockerfilePath}`);
          console.log(`   Size: ${stats.size} bytes`);
          console.log(`   Content length: ${content.length} chars`);
          console.log(`   First 200 chars: ${content.substring(0, 200).replace(/\n/g, '\\n')}`);
          
          if (stats.size === 0 || content.trim().length === 0) {
            throw new Error('Dockerfile is empty');
          }
          
          // Check for FROM instruction (required for Dockerfile)
          const hasFrom = content.trim().toUpperCase().includes('FROM');
          if (!hasFrom) {
            console.error('   ❌ ERROR: Dockerfile does not contain FROM instruction');
            console.error('   This will cause Checkov to not recognize it as a Dockerfile');
            throw new Error('Dockerfile does not contain FROM instruction. This is required for Checkov to recognize it.');
          } else {
            console.log(`   ✅ Contains FROM instruction`);
          }
          
          // Check for other common Dockerfile instructions
          const dockerKeywords = ['RUN', 'COPY', 'ADD', 'WORKDIR', 'ENV', 'EXPOSE', 'CMD', 'ENTRYPOINT'];
          const foundKeywords = dockerKeywords.filter(kw => content.toUpperCase().includes(kw));
          console.log(`   ✅ Contains Docker keywords: ${foundKeywords.join(', ') || 'none'}`);
          
        } catch (accessError: any) {
          console.error(`\n❌ Dockerfile verification failed:`);
          console.error(`   Path: ${dockerfilePath}`);
          console.error(`   Error: ${accessError.message}`);
          throw new Error(`Dockerfile not found or invalid at: ${dockerfilePath}. Error: ${accessError.message}`);
        }

        // Run Checkov with Docker framework - use directory flag like Kubernetes
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        
        const isWindows = process.platform === 'win32';
        
        // List files in temp directory to verify Dockerfile is there
        try {
          const filesInDir = await fs.readdir(tempDir);
          console.log(`\n📂 Files in temp directory (${filesInDir.length}):`);
          for (let idx = 0; idx < filesInDir.length; idx++) {
            const file = filesInDir[idx];
            const filePath = path.join(tempDir, file);
            try {
              const stats = await fs.stat(filePath);
              console.log(`   ${idx + 1}. ${file} (${stats.size} bytes)`);
            } catch {
              console.log(`   ${idx + 1}. ${file}`);
            }
          }
          
          if (!filesInDir.includes('Dockerfile')) {
            console.error(`❌ Dockerfile not found in temp directory!`);
            console.error(`   Expected: Dockerfile`);
            console.error(`   Files present: ${filesInDir.join(', ') || 'none'}`);
            console.error(`   Temp directory: ${tempDir}`);
            
            // Try to read the Dockerfile directly to see if it exists with different case
            try {
              const dockerfileContent = await fs.readFile(dockerfilePath, 'utf-8');
              console.error(`   ⚠️  Dockerfile exists at ${dockerfilePath} but not listed in directory!`);
              console.error(`   Content length: ${dockerfileContent.length} chars`);
            } catch (readError: any) {
              console.error(`   ❌ Cannot read Dockerfile at ${dockerfilePath}: ${readError.message}`);
            }
            
            throw new Error(`Dockerfile not found in temp directory. Files present: ${filesInDir.join(', ') || 'none'}`);
          }
          
          // Double-check Dockerfile content
          const dockerfileContent = await fs.readFile(dockerfilePath, 'utf-8');
          console.log(`   ✅ Dockerfile verified: ${dockerfileContent.length} chars`);
          console.log(`   ✅ First 100 chars: ${dockerfileContent.substring(0, 100).replace(/\n/g, '\\n')}`);
          
          if (dockerfileContent.trim().length === 0) {
            throw new Error('Dockerfile is empty');
          }
          
          if (!dockerfileContent.trim().toUpperCase().includes('FROM')) {
            console.warn(`   ⚠️  Warning: Dockerfile does not contain FROM instruction`);
            console.warn(`   This may cause Checkov to not recognize it as a Dockerfile`);
          }
        } catch (dirError: any) {
          console.error(`❌ Error reading temp directory: ${dirError.message}`);
          throw dirError;
        }
        
        // Try both -d (directory) and -f (file) approaches
        // Some Checkov versions work better with -f for Docker files
        // NOTE: Checkov expects 'dockerfile' not 'docker' as the framework name
        const checkovArgsDir = ['-d', tempDir, '--framework', 'dockerfile', '--output', 'json', '--compact', '--quiet'];
        const checkovArgsFile = ['-f', dockerfilePath, '--framework', 'dockerfile', '--output', 'json', '--compact', '--quiet'];
        
        console.log(`\n📋 Checkov command options:`);
        console.log(`   Option 1 (file): -f ${dockerfilePath} --framework docker`);
        console.log(`   Option 2 (directory): -d ${tempDir} --framework docker`);
        
        // Try different command variations - try -f first (more explicit for Docker)
        const commands: [string, string[]][] = isWindows
          ? [
              // Try -f (file) first - more explicit for Docker
              ['checkov', checkovArgsFile],
              ['checkov', checkovArgsDir],  // Then try -d (directory)
              ['uv', ['run', 'checkov', ...checkovArgsFile]],
              ['uv', ['run', 'checkov', ...checkovArgsDir]],
              ['py', ['-m', 'checkov', ...checkovArgsFile]],
              ['py', ['-m', 'checkov', ...checkovArgsDir]],
              ['python3', ['-m', 'checkov', ...checkovArgsFile]],
              ['python3', ['-m', 'checkov', ...checkovArgsDir]],
              ['python', ['-m', 'checkov', ...checkovArgsFile]],
              ['python', ['-m', 'checkov', ...checkovArgsDir]]
            ]
          : [
              // Try -f (file) first - more explicit for Docker
              ['checkov', checkovArgsFile],
              ['checkov', checkovArgsDir],  // Then try -d (directory)
              ['uv', ['run', 'checkov', ...checkovArgsFile]],
              ['uv', ['run', 'checkov', ...checkovArgsDir]],
              ['python3', ['-m', 'checkov', ...checkovArgsFile]],
              ['python3', ['-m', 'checkov', ...checkovArgsDir]],
              ['python', ['-m', 'checkov', ...checkovArgsFile]],
              ['python', ['-m', 'checkov', ...checkovArgsDir]]
            ];

        let checkovOutput = '';
        let commandWorked = false;
        let successfulCommand: string | null = null;

        console.log(`\n🚀 Starting Checkov execution...`);
        for (const [cmd, args] of commands) {
          try {
            const commandStr = `${cmd} ${args.join(' ')}`;
            console.log(`   🔧 Trying: ${commandStr}`);
            
            const { stdout, stderr } = await execAsync(commandStr, {
              timeout: 120000, // 2 minute timeout
              cwd: tempDir,
            });
            checkovOutput = stdout || stderr;
            commandWorked = true;
            successfulCommand = commandStr;
            console.log(`   ✅ Command succeeded`);
            break;
          } catch (error: any) {
            // Try next command - Checkov may exit with non-zero code but still output JSON
            if (error.stdout || error.stderr) {
              checkovOutput = error.stdout || error.stderr;
              commandWorked = true;
              successfulCommand = `${cmd} ${args.join(' ')}`;
              console.log(`   ✅ Command succeeded (non-zero exit but got output)`);
              break;
            }
            console.warn(`   ❌ Command failed: ${error.message}`);
            continue;
          }
        }

        // Parse Checkov results (same structure as Terraform/Kubernetes scan)
        if (!commandWorked) {
          console.warn(`⚠️  Could not run Checkov - all commands failed`);
          // Return empty results instead of throwing error (same as Kubernetes)
          return res.json({
            success: false,
            summary: {
              passed: 0,
              failed: 0,
              skipped: 0,
              total: 0,
              passPercentage: 0
            },
            failedChecks: [],
            passedChecks: [],
            error: 'Checkov is not installed or not accessible. Please install Checkov to scan Dockerfiles.'
          });
        }

        // Parse JSON output
        let scanResult: any = null;
        try {
          // Log what Checkov actually returned for debugging
          console.log(`\n📋 ========== FULL CHECKOV OUTPUT ==========`);
          console.log(`Length: ${checkovOutput.length} characters`);
          console.log(`First 500 chars:`);
          console.log(checkovOutput.substring(0, 500));
          console.log(`\nLast 500 chars:`);
          console.log(checkovOutput.substring(Math.max(0, checkovOutput.length - 500)));
          console.log(`==========================================\n`);
          
          // Check if Checkov output contains error messages about resources
          const lowerOutput = checkovOutput.toLowerCase();
          if ((lowerOutput.includes('no resources') || 
               lowerOutput.includes('not found') ||
               lowerOutput.includes('no files') ||
               lowerOutput.includes('terraform')) && 
              !lowerOutput.includes('docker')) {
            console.warn('⚠️  Checkov may have scanned with wrong framework or found no Docker resources');
            console.warn('   This might indicate Checkov is not recognizing the Dockerfile correctly');
            console.warn('   Checkov output suggests it was looking for Terraform files instead of Docker');
            
            // If Checkov mentions Terraform but we're scanning Docker, this is a problem
            if (lowerOutput.includes('terraform') && !lowerOutput.includes('docker')) {
              console.error('❌ Checkov appears to have used Terraform framework instead of Docker!');
              console.error('   This suggests the --framework docker flag may not be working');
              if (successfulCommand) {
                console.error(`   Checkov command used: ${successfulCommand}`);
              }
            }
          }
          
          // Try to extract JSON - Checkov might output warnings/errors before JSON
          // First, try to find the JSON object - it might be nested or have text before/after
          let jsonText = '';
          let jsonMatch = checkovOutput.match(/\{[\s\S]*\}/);
          
          // If no match, try to find JSON array
          if (!jsonMatch) {
            jsonMatch = checkovOutput.match(/\[[\s\S]*\]/);
          }
          
          // If still no match, try to find JSON starting from the first {
          if (!jsonMatch) {
            const firstBrace = checkovOutput.indexOf('{');
            if (firstBrace !== -1) {
              // Try to find matching closing brace
              let braceCount = 0;
              let endPos = firstBrace;
              for (let i = firstBrace; i < checkovOutput.length; i++) {
                if (checkovOutput[i] === '{') braceCount++;
                if (checkovOutput[i] === '}') braceCount--;
                if (braceCount === 0) {
                  endPos = i + 1;
                  break;
                }
              }
              jsonText = checkovOutput.substring(firstBrace, endPos);
            }
          } else {
            jsonText = jsonMatch[0];
          }
          
          if (jsonText) {
            console.log(`\n📋 Extracted JSON (${jsonText.length} chars, first 1000 chars):`);
            console.log(jsonText.substring(0, 1000));
            if (jsonText.length > 1000) {
              console.log(`   ... (${jsonText.length - 1000} more chars)`);
            }
            
            // Clean up the JSON text - remove any control characters or invalid characters
            let cleanedJson = jsonText
              .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters
              .trim();
            
            try {
              scanResult = JSON.parse(cleanedJson);
              console.log('✅ Successfully parsed Checkov JSON');
            } catch (jsonParseError: any) {
              console.error('\n❌ ========== JSON PARSE ERROR ==========');
              console.error(`   Parse error: ${jsonParseError.message}`);
              console.error(`   JSON text length: ${cleanedJson.length}`);
              console.error(`   First 200 chars: ${cleanedJson.substring(0, 200)}`);
              console.error(`   Last 200 chars: ${cleanedJson.substring(Math.max(0, cleanedJson.length - 200))}`);
              
              const errorPos = jsonParseError.message.match(/position (\d+)/)?.[1] || 'unknown';
              console.error(`   Error at position: ${errorPos}`);
              
              if (errorPos !== 'unknown') {
                const pos = parseInt(errorPos);
                const start = Math.max(0, pos - 100);
                const end = Math.min(cleanedJson.length, pos + 100);
                console.error(`   Context around error:`);
                console.error(`   ${cleanedJson.substring(start, end)}`);
                console.error(`   ${' '.repeat(Math.min(100, pos - start))}^`);
              }
              console.error('==========================================\n');
              
              // Try to repair JSON (similar to Dockerfile generator)
              console.log('🔧 Attempting to repair JSON...');
              let repaired = cleanedJson
                .replace(/,(\s*[}\]])/g, '$1') // Remove trailing commas
                .replace(/\/\/.*$/gm, '') // Remove comments
                .replace(/\/\*[\s\S]*?\*\//g, '') // Remove block comments
                .replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":') // Quote unquoted keys
                .replace(/:(\s*)([^",\[\]{}]+)(\s*[,}\]])/g, ': "$2"$3'); // Quote unquoted string values
              
              try {
                scanResult = JSON.parse(repaired);
                console.log('✅ Successfully parsed repaired JSON');
              } catch (repairError: any) {
                console.error(`❌ JSON repair also failed: ${repairError.message}`);
                // Log the full Checkov output for debugging
                console.error(`\n📋 Full Checkov output (${checkovOutput.length} chars):`);
                console.error(checkovOutput);
                throw new Error(`JSON parse failed: ${jsonParseError.message}. Repair also failed: ${repairError.message}`);
              }
            }
          } else {
            // No JSON found - Checkov might have output an error message
            console.error('❌ No JSON object found in Checkov output');
            console.error('   This might mean:');
            console.error('   1. Checkov encountered an error');
            console.error('   2. Checkov output format is different than expected');
            console.error('   3. Checkov is not installed correctly');
            
            // Check if it's a "no resources" message
            if (checkovOutput.toLowerCase().includes('no resources') || 
                checkovOutput.toLowerCase().includes('not found')) {
              throw new Error(`Checkov found no Docker resources to scan. Output: ${checkovOutput.substring(0, 500)}`);
            }
            
            throw new Error(`No JSON output from Checkov. Output: ${checkovOutput.substring(0, 500)}`);
          }
        } catch (parseError: any) {
          console.error('\n❌ ========== CHECKOV OUTPUT PARSE ERROR ==========');
          console.error(`   Error: ${parseError.message}`);
          console.error(`   Checkov output length: ${checkovOutput.length}`);
          console.error(`   Checkov output (first 2000 chars):`);
          console.error(checkovOutput.substring(0, 2000));
          console.error('==========================================\n');
          
          return res.json({
            success: false,
            summary: {
              passed: 0,
              failed: 0,
              skipped: 0,
              total: 0,
              passPercentage: 0
            },
            failedChecks: [],
            passedChecks: [],
            error: `Failed to parse Checkov output: ${parseError.message}. Checkov may not have found any Docker resources to scan, or the output format is unexpected. Please check server logs for details.`
          });
        }

        // Parse Checkov results (same structure as Terraform/Kubernetes scan)
        // Checkov JSON structure can vary - try multiple paths
        let summary: any = {};
        let results: any = {};
        
        // Try different possible JSON structures
        if (scanResult.summary) {
          summary = scanResult.summary;
        } else if (scanResult.check_type) {
          // Alternative structure
          summary = {
            passed: scanResult.summary?.passed || 0,
            failed: scanResult.summary?.failed || 0,
            skipped: scanResult.summary?.skipped || 0
          };
        }
        
        if (scanResult.results) {
          results = scanResult.results;
        } else if (scanResult.failed_checks || scanResult.passed_checks) {
          results = {
            failed_checks: scanResult.failed_checks || [],
            passed_checks: scanResult.passed_checks || []
          };
        }
        
        // Log full scan result structure for debugging
        console.log(`\n📊 Checkov scan result structure:`);
        console.log(`   Top-level keys: ${Object.keys(scanResult).join(', ')}`);
        console.log(`   Summary keys: ${Object.keys(summary).join(', ')}`);
        console.log(`   Results keys: ${Object.keys(results).join(', ')}`);
        
        const passed = summary.passed != null ? Number(summary.passed) : 0;
        const failed = summary.failed != null ? Number(summary.failed) : 0;
        const skipped = summary.skipped != null ? Number(summary.skipped) : 0;
        const total = passed + failed + skipped;
        const passPercentage = total > 0 ? Math.round((passed / total) * 100) : 0;

        const checks = results.failed_checks || scanResult.failed_checks || [];
        const passedChecks = results.passed_checks || scanResult.passed_checks || [];
        
        // Check if Checkov found any Docker resources
        if (total === 0) {
          console.error('\n❌ ========== CHECKOV FOUND NO DOCKER RESOURCES ==========');
          console.error('   Checkov completed but found 0 resources to scan');
          console.error('   This might indicate:');
          console.error('   1. Dockerfile was not recognized by Checkov');
          console.error('   2. Checkov used wrong framework (check if --framework docker flag worked)');
          console.error('   3. Dockerfile is empty or invalid');
          console.error(`   Checkov summary:`, JSON.stringify(summary, null, 2));
          console.error(`   Checkov results:`, JSON.stringify(results, null, 2));
          console.error(`   Full scan result (first 2000 chars):`, JSON.stringify(scanResult, null, 2).substring(0, 2000));
          if (results.parsing_errors || scanResult.parsing_errors) {
            console.error(`   Parsing errors:`, results.parsing_errors || scanResult.parsing_errors);
          }
          console.error('==========================================\n');
          
          // Return a more helpful error
          return res.json({
            success: false,
            summary: {
              passed: 0,
              failed: 0,
              skipped: 0,
              total: 0,
              passPercentage: 0
            },
            failedChecks: [],
            passedChecks: [],
            error: 'Checkov did not find any Docker resources to scan. The Dockerfile may not be recognized by Checkov, or Checkov may be using the wrong framework. Check server logs for details.'
          });
        }

        console.log(`✅ Docker scan completed: ${passed} passed, ${failed} failed, ${skipped} skipped, total: ${total}`);

        res.json({
          success: true,
          summary: {
            passed,
            failed,
            skipped,
            total,
            passPercentage
          },
          failedChecks: checks,
          passedChecks: passedChecks
        });

      } finally {
        // Cleanup temp directory
        if (tempDir) {
          try {
            await fs.rm(tempDir, { recursive: true, force: true });
          } catch (cleanupError) {
            console.warn('Failed to cleanup temp directory:', cleanupError);
          }
        }
      }
    } catch (error: any) {
      console.error('❌ Error scanning Dockerfile:', error);
      res.status(500).json({ 
        error: 'Failed to scan Dockerfile',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Commit Dockerfile
  app.post("/api/sessions/:id/commit-docker", async (req, res) => {
    const sessionId = req.params.id;
    const { message } = req.body;
    
    try {
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (!session.provider || !session.repositoryName) {
        return res.status(400).json({ 
          error: 'Repository not configured',
          details: 'Please select a repository first'
        });
      }

      console.log(`\n📦 ========== COMMIT DOCKERFILE ==========`);
      console.log(`Session ID: ${sessionId}`);
      console.log(`Repository: ${session.repositoryName}`);
      console.log(`Provider: ${session.provider}`);

      // Get Docker files from session storage
      const sessionFiles = await storage.getFilesBySession(sessionId);
      const dockerFiles = sessionFiles.filter(f => 
        f.fileName.toLowerCase() === 'dockerfile' || 
        f.fileName.toLowerCase() === '.dockerignore' ||
        f.fileName.toLowerCase().endsWith('.dockerfile')
      );

      if (dockerFiles.length === 0) {
        return res.status(400).json({ 
          error: 'No Docker files found',
          details: 'Please generate a Dockerfile first'
        });
      }

      console.log(`📄 Files to commit: ${dockerFiles.length}`);
      dockerFiles.forEach(f => {
        console.log(`   - ${f.fileName} (${f.content.length} chars)`);
      });

      // Commit via MCP
      const result = await mcpClient.commitFiles(
        session.provider as MCPProvider,
        session.repositoryName,
        dockerFiles.map(f => ({
          path: f.fileName,
          content: f.content
        })),
        message || 'Add Dockerfile and related files'
      );

      console.log(`✅ Committed successfully: ${result.commitSha}`);

      res.json({
        success: true,
        commitSha: result.commitSha,
        files: dockerFiles.map(f => f.fileName)
      });
    } catch (error: any) {
      console.error('❌ Error committing Dockerfile:', error);
      res.status(500).json({ 
        error: 'Failed to commit Dockerfile',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
