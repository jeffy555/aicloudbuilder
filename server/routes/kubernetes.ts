/**
 * Kubernetes-specific API routes
 * Handles Kubernetes manifest generation, validation, scanning, and diagram generation
 */

import type { Express, Response } from "express";
import { aiChatCompletion } from '../utils/ai-client.js';
import { storage } from "../storage";
import { mcpClient, type MCPProvider } from "../mcp-client";
import { openaiService } from "../openai-service";
import { optionalAuth, type AuthenticatedRequest } from "../middleware/auth";
import { validateRequest } from "../middleware/validate";
import { aiMediumLimiter } from "../middleware/rate-limit";
import { sessionIdParams } from "@shared/api-contracts/common";
import {
  generateK8sManifestsBody,
  commitK8sBody,
  scanK8sBody,
  validateK8sBody,
  fixK8sValidationBody,
  validateHelmBody,
  generateK8sDiagramBody,
  k8sFixBody,
  k8sFixVerifyBody,
  k8sFixBatchBody,
  scanRepoForHelmBody,
  analyzeRepoBody,
  generateHelmChartBody,
  uploadHelmChartBody,
  buildKustomizeBody,
  securityScoreBody,
  policyCheckBody,
  rightsizeK8sBody,
  estimateK8sCostBody,
} from "@shared/api-contracts/kubernetes";
import { resolveRepositoryCredentials } from "../utils/credentials";
import { generateKubernetesManifests } from "../kubernetes/manifest-generator";
import { validateHelmChart } from "../kubernetes/helm-validation-service";
import { generateKubernetesDiagram } from "../kubernetes/diagram-generator";
import { runCheckovKubernetes, runCheckovHelm, runKubernetesSecurityScanFallback } from "../kubernetes/checkov-validator";
import { analyzeKubernetesBestPractices } from "../kubernetes/best-practices-analyzer";
import { validateKubernetesYAML } from "../kubernetes/kubeval-validator";
import { buildKustomize } from "../kubernetes/kustomize-validator";
import { scoreSecurityContexts } from "../kubernetes/security-scorer";
import { checkPolicyHints } from "../kubernetes/policy-hints";
import { estimateKubernetesCost } from "../kubernetes/cost-estimator";
import { generateK8sRightsizingRecommendations } from "../kubernetes/resource-rightsizing";
import { getFixGuidance } from "../checkov-fix-guidance";
import { createRequire } from "module";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const _require = createRequire(import.meta.url);
const formidable = _require("formidable");



/**
 * Register Kubernetes-specific routes
 */
export function registerKubernetesRoutes(app: Express) {
  const ensureSessionOwnership = (
    session: any,
    req: AuthenticatedRequest,
    res: Response
  ): boolean => {
    // Anonymous sessions (no userId) are accessible to anyone.
    // Owned sessions require matching userId.
    if (session?.userId && session.userId !== req.userId) {
      res.status(403).json({ error: "Forbidden: session does not belong to the current user" });
      return false;
    }
    return true;
  };

  // Generate Kubernetes manifests
  app.post("/api/sessions/:id/generate-kubernetes-manifests", aiMediumLimiter, validateRequest({ params: sessionIdParams, body: generateK8sManifestsBody }), async (req, res) => {
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
        const { validateKubernetesInput } = await import('../kubernetes/input-validator');
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
  app.post("/api/sessions/:id/commit-kubernetes", validateRequest({ params: sessionIdParams, body: commitK8sBody }), async (req, res) => {
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
  app.post("/api/sessions/:id/scan-kubernetes", validateRequest({ params: sessionIdParams, body: scanK8sBody }), async (req, res) => {
    try {
      const sessionId = req.params.id;
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      console.log(`\n🔍 ========== KUBERNETES SECURITY SCAN ==========`);
      console.log(`Session ID: ${sessionId}`);

      // Get all files from session storage
      const files = await storage.getFilesBySession(sessionId);

      if (files.length === 0) {
        return res.status(400).json({
          error: 'No files found',
          details: 'No files found in session storage'
        });
      }

      // Detect Helm chart: session has Chart.yaml or templates/ files
      const isHelmChart = files.some(f =>
        /^chart\.yaml$/i.test(f.fileName) ||
        f.fileName.startsWith('templates/')
      );

      let checkovResult;
      // Holds plain-YAML files the TS fallback scanner can parse (used if Checkov returns 0)
      let fallbackScanFiles: Array<{ path: string; content: string }> = [];

      if (isHelmChart) {
        // ── Helm chart scan ────────────────────────────────────────────────
        // Write chart files to a temp dir, render with `helm template`, then
        // scan the rendered Kubernetes YAML with runCheckovKubernetes.
        // This is more reliable than --framework helm which requires the helm plugin.
        const { randomUUID } = await import('crypto');
        const { renderHelmChart } = await import('../kubernetes/helm-validator');
        const tempDir = path.join(os.tmpdir(), `helm-scan-${randomUUID()}`);
        try {
          for (const f of files) {
            const fullPath = path.join(tempDir, f.fileName);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, f.content, 'utf-8');
          }
          console.log(`⛵ Helm chart detected — rendering ${files.length} file(s) then scanning with Checkov`);
          const rendered = await renderHelmChart(tempDir).catch(() => [] as string[]);
          if (rendered.length === 0) {
            // Fall back to --framework helm if rendering fails (e.g. helm not installed)
            console.warn('   helm template failed — falling back to --framework helm');
            const helmFiles = files
              .filter(f => f.fileName !== '.helmignore')
              .map(f => ({ path: f.fileName, content: f.content }));
            checkovResult = await runCheckovHelm(helmFiles);
            // Populate fallback by stripping Go template syntax so TS scanner can parse them
            fallbackScanFiles = files
              .filter(f => f.fileName.startsWith('templates/') && (f.fileName.endsWith('.yaml') || f.fileName.endsWith('.yml')))
              .map(f => ({
                path: f.fileName,
                content: f.content.split('\n').map(line => {
                  if (!line.includes('{{')) return line;
                  // Pure template line (only whitespace + {{ ... }}) — drop it
                  if (/^\s*\{\{[^}]*\}\}\s*$/.test(line)) return '';
                  // Inline: replace "{{ ... }}" (quoted) with "placeholder"
                  let out = line
                    .replace(/"[^"]*\{\{[^"]*"/g, '"placeholder"')
                    .replace(/'[^']*\{\{[^']*'/g, "'placeholder'");
                  // Replace any remaining unquoted {{ ... }} with placeholder
                  out = out.replace(/\{\{[^}]*\}\}/g, 'placeholder');
                  return out;
                }).join('\n'),
              }));
            console.log(`   TS fallback: stripped ${fallbackScanFiles.length} template file(s) for security scan`);
          } else {
            // Preserve template source path so fix-issues can map checks back to
            // real session files (templates/*.yaml) and show approval diffs.
            const renderedYamlFiles = rendered.map((content, i) => {
              const sourceMatch = content.match(/^\s*#\s*Source:\s*(.+)\s*$/m);
              const sourcePath = sourceMatch?.[1]?.trim();
              const normalizedSourcePath = sourcePath?.replace(/^[^/]+\/templates\//i, 'templates/');
              const fallbackPath = `rendered-${i}.yaml`;
              return {
                path: normalizedSourcePath || sourcePath || fallbackPath,
                content,
              };
            });
            console.log(`   ✅ Rendered ${rendered.length} template(s) — scanning with Checkov`);
            // Save rendered files so the TS fallback can scan them if Checkov returns 0
            fallbackScanFiles = renderedYamlFiles;
            checkovResult = await runCheckovKubernetes(renderedYamlFiles);
          }
        } finally {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      } else {
        // ── Plain Kubernetes manifests scan ───────────────────────────────
        const yamlFiles = files.filter(f =>
          f.fileName.endsWith('.yaml') || f.fileName.endsWith('.yml')
        );

        if (yamlFiles.length === 0) {
          return res.status(400).json({
            error: 'No Kubernetes files found',
            details: 'No YAML files found in session storage'
          });
        }

        console.log(`📁 Found ${yamlFiles.length} Kubernetes manifest file(s)`);
        checkovResult = await runCheckovKubernetes(
          yamlFiles.map(f => ({ path: f.fileName, content: f.content }))
        );
      }

      // Format response similar to Terraform scan - use same comprehensive parsing logic
      const failedChecks = checkovResult.checks.map(check => {
        // Ensure reason is always present and meaningful
        const reason = check.message || check.guideline || `Security check ${check.checkId} failed for resource ${check.resource}`;
        const guidance = getFixGuidance(check.checkId, check.checkName);

        console.log(`📋 Formatted check: ${check.checkId} - Reason: ${reason.substring(0, 80)}...`);

        return {
          checkId: check.checkId,
          checkName: check.checkName,
          resource: check.resource,
          file: check.file,
          guideline: check.guideline,
          reason: reason,
          severity: guidance?.severity || null,
          autoFixable: guidance?.autoFixable ?? false,
          fixComplexity: guidance?.fixComplexity || 'moderate',
          complianceStandards: guidance?.complianceStandards || [],
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
      
      // Safety net: if Checkov returned 0 results for any reason, use the pure TS scanner
      if (total === 0) {
        console.warn(`\n⚠️  Checkov returned 0 results — activating TypeScript security scanner fallback`);
        // Prefer rendered YAML / stripped templates (no Go syntax) over raw session files
        const plainFiles = fallbackScanFiles.length > 0
          ? fallbackScanFiles
          : files
              .filter(f => f.fileName.endsWith('.yaml') || f.fileName.endsWith('.yml'))
              .map(f => ({ path: f.fileName, content: f.content }));
        const fallback = await runKubernetesSecurityScanFallback(plainFiles);
        const fbTotal = fallback.passed + fallback.failed;
        console.log(`   TS fallback: passed=${fallback.passed}, failed=${fallback.failed}, total=${fbTotal}`);
        if (fbTotal > 0) {
          const fbPct = fbTotal > 0 ? Math.round((fallback.passed / fbTotal) * 100) : 0;
          return res.json({
            success: true,
            summary: { passed: fallback.passed, failed: fallback.failed, skipped: 0, total: fbTotal, passPercentage: fbPct },
            failedChecks: fallback.checks.map(c => ({
              checkId: c.checkId, checkName: c.checkName, resource: c.resource,
              file: c.file, guideline: c.guideline, reason: c.message,
            })),
            passedChecks: [],
          });
        }
      }

      console.log(`==========================================\n`);

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
  app.post("/api/sessions/:id/validate-kubernetes", validateRequest({ params: sessionIdParams, body: validateK8sBody }), async (req, res) => {
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
          file: (err as any).file,
          line: (err as any).line,
        })),
        warnings: combinedWarnings.map(warn => ({
          severity: warn.severity,
          message: warn.message,
          file: (warn as any).file,
          line: (warn as any).line,
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

  // Fix Kubernetes validation issues (best practices + schema)
  app.post("/api/sessions/:id/fix-kubernetes-validation", validateRequest({ params: sessionIdParams, body: fixK8sValidationBody }), async (req, res) => {
    try {
      const sessionId = req.params.id;
      const { issues } = req.body;

      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      console.log(`\n🔧 ========== KUBERNETES VALIDATION FIX ==========`);
      console.log(`Session ID: ${sessionId}`);
      console.log(`Issues to fix: ${issues?.length || 'all'}`);

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

      console.log(`📁 Found ${yamlFiles.length} Kubernetes file(s) to fix`);

      // Process each file independently — avoids token limits and improves fix coverage
      const systemPrompt = `You are an expert Kubernetes engineer. Fix issues in the given Kubernetes YAML manifest.

RULES:
1. Fix ALL the listed issues while preserving resource names, labels, and selectors
2. Apply best practices: resource limits/requests, liveness/readiness probes, security contexts
   (runAsNonRoot: true, readOnlyRootFilesystem: true, allowPrivilegeEscalation: false)
3. Output ONLY raw valid YAML — no markdown fences, no explanations, no comments`;

      const updatedFiles: Array<{ fileName: string; content: string }> = [];
      const errors: string[] = [];

      for (const file of yamlFiles) {
        try {
          // Find issues relevant to this file (match by filename or apply all general issues)
          const fileIssues = issues && issues.length > 0
            ? issues.filter((i: any) => !i.file || i.file === file.fileName || i.file.includes(file.fileName))
            : [];

          const issuesList = fileIssues.length > 0
            ? fileIssues.map((i: any) => `- ${i.message || i.issue}`).join('\n')
            : issues && issues.length > 0
              ? issues.map((i: any) => `- ${i.message || i.issue}`).join('\n')
              : 'Apply all Kubernetes best practices: resource limits, probes, security contexts';

          const userPrompt = `Fix the following issues in this Kubernetes manifest (${file.fileName}):

ISSUES:
${issuesList}

CURRENT YAML:
${file.content}

Return ONLY the fixed YAML. No explanations, no code blocks.`;

          console.log(`   🔧 Fixing ${file.fileName} (${fileIssues.length} targeted issues)...`);

          const completion = await aiChatCompletion({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ],
            temperature: 0.1,
            max_tokens: 4000
          });

          let fixedContent = completion.choices[0]?.message?.content || '';
          fixedContent = fixedContent
            .replace(/^```ya?ml\s*\n?/i, '')
            .replace(/^```\s*\n?/, '')
            .replace(/\n?```\s*$/, '')
            .trim();

          if (!fixedContent) {
            errors.push(`AI returned empty content for ${file.fileName}`);
            continue;
          }

          await storage.updateFile(file.id, fixedContent);
          updatedFiles.push({ fileName: file.fileName, content: fixedContent });
          console.log(`   ✅ Fixed: ${file.fileName}`);
        } catch (fileError: any) {
          const error = `Failed to fix ${file.fileName}: ${fileError.message}`;
          console.error(`   ❌ ${error}`);
          errors.push(error);
        }
      }

      if (errors.length > 0) {
        console.warn(`\n⚠️  Encountered ${errors.length} error(s) during fix application:`);
        errors.forEach((err, idx) => console.warn(`   ${idx + 1}. ${err}`));
      }

      console.log(`\n✅ Fixed ${updatedFiles.length} file(s)`);
      if (errors.length > 0) {
        console.log(`⚠️  ${errors.length} error(s) occurred during processing`);
      }
      console.log('==========================================\n');

      if (updatedFiles.length === 0) {
        return res.status(500).json({
          success: false,
          error: 'No files were updated',
          details: errors.length > 0
            ? `Failed to update files: ${errors.join('; ')}`
            : 'AI generated fixes but no files could be parsed or matched',
          errors
        });
      }

      res.json({
        success: true,
        message: `Fixed ${updatedFiles.length} file(s) with best practices applied`,
        updatedFiles: updatedFiles.map(f => f.fileName),
        totalFixed: updatedFiles.length,
        errors: errors.length > 0 ? errors : undefined
      });

    } catch (error: any) {
      console.error('❌ Error fixing Kubernetes validation issues:', error);
      res.status(500).json({
        error: 'Failed to fix Kubernetes validation issues',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Validate Helm chart
  app.post("/api/sessions/:id/validate-helm-chart", optionalAuth, validateRequest({ params: sessionIdParams, body: validateHelmBody }), async (req: AuthenticatedRequest, res) => {
    try {
      const { options } = req.body;
      const sessionId = req.params.id;

      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!ensureSessionOwnership(session, req, res)) return;

      const chartPath = (session as any).helmChartPath;
      if (!chartPath || typeof chartPath !== "string") {
        return res.status(400).json({
          error: "No uploaded Helm chart found",
          details: "Upload a Helm chart archive first, then run validation."
        });
      }

      console.log(`\n🔍 ========== HELM CHART VALIDATION ==========`);
      console.log(`Session ID: ${sessionId}`);
      console.log(`Chart Path: ${chartPath}`);

      // Fetch session files to pass as raw helm source for deep analysis
      const sessionFiles = await storage.getFilesBySession(sessionId);
      const helmFiles = sessionFiles
        .filter(f => f.content && f.content.trim().length > 0)
        .map(f => ({ path: f.fileName, content: f.content }));

      // Validate Helm chart
      const result = await validateHelmChart(chartPath, {
        runHelmLint: true,
        runKubeval: true,
        runCheckov: true,
        runBestPractices: false,   // replaced by deep analysis
        runDeepAnalysis: true,
        helmFiles,
        ...(options || {}),
      });

      console.log('==========================================\n');

      res.json({
        success: result.success,
        issues: result.issues,
        lintResults: result.lintResults,
        bestPractices: result.bestPractices,
        deepAnalysis: result.deepAnalysis,
        summary: result.summary,
      });

    } catch (error: any) {
      console.error('❌ Error validating Helm chart:', error);
      const message = typeof error?.message === "string" ? error.message : "Unknown validation error";
      const normalizedMessage = message.includes("ENOENT")
        ? "Uploaded Helm chart is no longer available. Please upload it again."
        : message;
      res.status(500).json({
        error: 'Failed to validate Helm chart',
        details: normalizedMessage,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Generate Kubernetes diagram from manifests
  app.post("/api/sessions/:id/generate-kubernetes-diagram", aiMediumLimiter, validateRequest({ params: sessionIdParams, body: generateK8sDiagramBody }), async (req, res) => {
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

      // Detect Helm chart sessions — Chart.yaml is the indicator
      const isHelmSession = sessionFiles.some(f => f.fileName === 'Chart.yaml');

      const yamlFiles = sessionFiles
        .filter(f => {
          if (!f.fileName.endsWith('.yaml') && !f.fileName.endsWith('.yml')) return false;
          if (isHelmSession) {
            // Exclude Helm metadata files — they aren't K8s manifests
            const base = f.fileName.split('/').pop() || '';
            if (base === 'Chart.yaml') return false;
            if (base.startsWith('values')) return false; // values.yaml, values-dev.yaml, values-prod.yaml
          }
          return true;
        })
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

  // Get fix for Kubernetes security issue (RAG-based retrieval)
  app.post("/api/sessions/:id/kubernetes-fix", aiMediumLimiter, validateRequest({ params: sessionIdParams, body: k8sFixBody }), async (req, res) => {
    try {
      const { checkId, checkName, resourceKind, guideline, currentYaml } = req.body;
      const sessionId = req.params.id;

      if (!checkId || !resourceKind) {
        return res.status(400).json({
          error: 'Missing required fields',
          details: 'checkId and resourceKind are required'
        });
      }

      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      console.log(`\n🔧 ========== KUBERNETES FIX RETRIEVAL ==========`);
      console.log(`Session ID: ${sessionId}`);
      console.log(`Check ID: ${checkId}`);
      console.log(`Resource Kind: ${resourceKind}`);

      // Import intelligent fix retriever
      const { intelligentFixRetriever } = await import('../rag/intelligent-fix-retriever');

      // Get fix using intelligent retriever (framework: kubernetes)
      const fix = await intelligentFixRetriever.getFixForCheck(
        checkId,
        resourceKind,
        checkName || checkId,
        guideline || '',
        session.userId || undefined,
        currentYaml || undefined,
        'kubernetes', // cloudProvider
        'kubernetes'  // framework
      );

      if (fix) {
        console.log(`✅ Fix retrieved for ${checkId}`);
        console.log(`   Source: ${fix.source}`);
        console.log(`   Confidence: ${(fix.confidence * 100).toFixed(1)}%`);
        console.log(`   Requires Review: ${fix.requiresReview}`);
        console.log('==========================================\n');

        res.json({
          success: true,
          fix: fix.fix,
          confidence: fix.confidence,
          source: fix.source,
          requiresReview: fix.requiresReview,
          metadata: fix.metadata
        });
      } else {
        console.log(`⚠️  No fix found for ${checkId}`);
        console.log('==========================================\n');

        res.status(404).json({
          success: false,
          error: 'No fix found',
          details: `No remediation found for ${checkId}. Try enabling AI generation with ENABLE_K8S_AI_GEN=true.`
        });
      }

    } catch (error: any) {
      console.error('❌ Error retrieving Kubernetes fix:', error);
      res.status(500).json({
        error: 'Failed to retrieve Kubernetes fix',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Verify Kubernetes fix worked (updates confidence)
  app.post("/api/sessions/:id/kubernetes-fix/verify", validateRequest({ params: sessionIdParams, body: k8sFixVerifyBody }), async (req, res) => {
    try {
      const { checkId, resourceKind, fix, success } = req.body;
      const sessionId = req.params.id;

      if (!checkId || !resourceKind || typeof success !== 'boolean') {
        return res.status(400).json({
          error: 'Missing required fields',
          details: 'checkId, resourceKind, and success (boolean) are required'
        });
      }

      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      console.log(`\n🔄 ========== KUBERNETES FIX VERIFICATION ==========`);
      console.log(`Session ID: ${sessionId}`);
      console.log(`Check ID: ${checkId}`);
      console.log(`Resource Kind: ${resourceKind}`);
      console.log(`Success: ${success}`);

      // Import intelligent fix retriever
      const { intelligentFixRetriever } = await import('../rag/intelligent-fix-retriever');

      if (success) {
        // Store/update verified fix
        await intelligentFixRetriever.storeVerifiedFix(
          checkId,
          resourceKind,
          fix || '',
          session.userId || undefined,
          true, // verified
          'kubernetes', // cloudProvider
          'kubernetes'  // framework
        );
        console.log(`✅ Fix verified and confidence updated`);
      } else {
        // Report fix failure
        await intelligentFixRetriever.reportFixFailure(
          checkId,
          resourceKind,
          session.userId || undefined,
          'kubernetes' // framework
        );
        console.log(`⚠️  Fix failure reported, confidence decreased`);
      }

      console.log('==========================================\n');

      res.json({
        success: true,
        message: success
          ? 'Fix verified successfully. Confidence increased.'
          : 'Fix failure recorded. Confidence decreased.'
      });

    } catch (error: any) {
      console.error('❌ Error verifying Kubernetes fix:', error);
      res.status(500).json({
        error: 'Failed to verify Kubernetes fix',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Get all Kubernetes fixes for a scan result (batch retrieval)
  app.post("/api/sessions/:id/kubernetes-fixes/batch", aiMediumLimiter, validateRequest({ params: sessionIdParams, body: k8sFixBatchBody }), async (req, res) => {
    try {
      const { checks } = req.body;
      const sessionId = req.params.id;

      if (!Array.isArray(checks) || checks.length === 0) {
        return res.status(400).json({
          error: 'Missing required fields',
          details: 'checks array is required and must not be empty'
        });
      }

      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      console.log(`\n🔧 ========== KUBERNETES BATCH FIX RETRIEVAL ==========`);
      console.log(`Session ID: ${sessionId}`);
      console.log(`Checks to process: ${checks.length}`);

      // Import intelligent fix retriever
      const { intelligentFixRetriever } = await import('../rag/intelligent-fix-retriever');

      // Process all checks in parallel
      const results = await Promise.all(
        checks.map(async (check: { checkId: string; checkName?: string; resourceKind: string; guideline?: string }) => {
          try {
            const fix = await intelligentFixRetriever.getFixForCheck(
              check.checkId,
              check.resourceKind,
              check.checkName || check.checkId,
              check.guideline || '',
              session.userId || undefined,
              undefined,
              'kubernetes',
              'kubernetes'
            );

            return {
              checkId: check.checkId,
              resourceKind: check.resourceKind,
              found: !!fix,
              fix: fix?.fix || null,
              confidence: fix?.confidence || 0,
              source: fix?.source || null,
              requiresReview: fix?.requiresReview ?? true
            };
          } catch (error: any) {
            return {
              checkId: check.checkId,
              resourceKind: check.resourceKind,
              found: false,
              error: error.message
            };
          }
        })
      );

      const foundCount = results.filter(r => r.found).length;
      console.log(`✅ Retrieved fixes for ${foundCount}/${checks.length} checks`);
      console.log('==========================================\n');

      res.json({
        success: true,
        totalChecks: checks.length,
        fixesFound: foundCount,
        results
      });

    } catch (error: any) {
      console.error('❌ Error in batch Kubernetes fix retrieval:', error);
      res.status(500).json({
        error: 'Failed to retrieve Kubernetes fixes',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // ─── Scan selected repo + auto-analyse for Helm chart generation ──────────
  app.post("/api/sessions/:id/scan-repo-for-helm", optionalAuth, validateRequest({ params: sessionIdParams, body: scanRepoForHelmBody }), async (req: AuthenticatedRequest, res) => {
    const sessionId = req.params.id;
    try {
      const session = await storage.getSession(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (!ensureSessionOwnership(session, req, res)) return;

      const { provider, repoName, branch = 'main' } = req.body as {
        provider?: string;
        repoName?: string;
        branch?: string;
      };

      if (!provider || !repoName) {
        return res.status(400).json({ error: 'provider and repoName are required' });
      }

      console.log(`\n🔍 Scanning repo "${repoName}" (${provider}) for Helm analysis...`);

      const { credentials } = await resolveRepositoryCredentials(provider as MCPProvider, req.userId);
      const { files: appFiles, totalRepoFiles } = await mcpClient.scanRepositoryAppFiles(
        provider as MCPProvider,
        repoName,
        branch,
        credentials
      );

      if (appFiles.length === 0) {
        if (totalRepoFiles > 0) {
          // Repo has files but no recognisable application code
          console.log(`   ⚠️ Repo has ${totalRepoFiles} file(s) but no app code detected`);
          return res.json({ isEmpty: false, noAppCode: true, analysis: null });
        }
        // Truly empty / brand-new repo
        return res.json({ isEmpty: true, analysis: null });
      }

      console.log(`   Found ${appFiles.length} app file(s): ${appFiles.map(f => f.name).join(', ')}`);

      const { analyzeRepositoryForHelm } = await import('../kubernetes/helm-generator');
      const analysis = await analyzeRepositoryForHelm(
        appFiles.map(f => ({ name: f.name, content: f.content }))
      );

      console.log(`✅ Helm repo analysis: framework=${analysis.framework}, port=${analysis.suggestedPort}`);
      res.json({ isEmpty: false, analysis, scannedFiles: appFiles.map(f => f.name) });
    } catch (error: any) {
      console.error('❌ scan-repo-for-helm error:', error);
      res.status(500).json({ error: 'Failed to scan repository', details: error.message });
    }
  });

  // ─── Analyse repository files for Helm chart generation ───────────────────
  app.post("/api/sessions/:id/analyze-repo", optionalAuth, validateRequest({ params: sessionIdParams, body: analyzeRepoBody }), async (req: AuthenticatedRequest, res) => {
    const sessionId = req.params.id;
    try {
      const session = await storage.getSession(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (!ensureSessionOwnership(session, req, res)) return;

      const { files } = req.body as {
        files?: Array<{ name: string; content: string }>;
      };

      if (!files || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: 'files array is required' });
      }

      const { analyzeRepositoryForHelm } = await import('../kubernetes/helm-generator');
      const result = await analyzeRepositoryForHelm(files);

      console.log(`✅ Repo analysis complete: framework=${result.framework}, port=${result.suggestedPort}`);
      res.json(result);
    } catch (error: any) {
      console.error('❌ analyze-repo error:', error);
      res.status(500).json({ error: 'Failed to analyse repository', details: error.message });
    }
  });

  // ─── Helm Chart Generator ──────────────────────────────────────────────────
  app.post("/api/sessions/:id/generate-helm-chart", optionalAuth, aiMediumLimiter, validateRequest({ params: sessionIdParams, body: generateHelmChartBody }), async (req: AuthenticatedRequest, res) => {
    const sessionId = req.params.id;
    try {
      const session = await storage.getSession(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (!ensureSessionOwnership(session, req, res)) return;

      const { description, options = {}, appContext } = req.body as {
        description?: string;
        appContext?: string;
        options?: {
          framework?: string;
          includeHPA?: boolean;
          includeIngress?: boolean;
          generateEnvOverlays?: boolean;
          replicas?: number;
          port?: number;
        };
      };

      if (!description || typeof description !== 'string' || !description.trim()) {
        return res.status(400).json({ error: 'description is required' });
      }

      console.log(`\n⛵ ========== HELM CHART GENERATE REQUEST ==========`);
      console.log(`Session: ${sessionId}`);

      // Clean up any previous helm-generator files in this session
      const helmGenPattern = /^(Chart\.yaml$|values[^/]*\.yaml$|templates\/|\.helmignore$)/i;
      const existingFiles = await storage.getFilesBySession(sessionId);
      for (const f of existingFiles) {
        if (helmGenPattern.test(f.fileName)) {
          await storage.deleteFile(f.id);
        }
      }

      // Generate
      const { generateHelmChart } = await import('../kubernetes/helm-generator');
      const result = await generateHelmChart(description.trim(), { ...options, appContext });

      // Persist each file
      const savedFiles = [];
      for (const file of result.files) {
        const saved = await storage.createFile({
          sessionId,
          fileName: file.path,
          content: file.content,
        });
        savedFiles.push(saved);
      }

      await storage.updateSession(sessionId, {
        workflowStep: 'helm_generation',
        activeModule: 'kubernetes',
        currentStep: '5',
      });

      console.log(`✅ Helm chart saved: ${savedFiles.length} file(s)`);

      res.json({
        success: true,
        chartName: result.chartName,
        files: savedFiles,
        lintResult: result.lintResult ?? null,
      });
    } catch (error: any) {
      console.error('❌ Helm chart generation failed:', error);
      res.status(500).json({ error: 'Helm chart generation failed', details: error.message });
    }
  });

  // ─── D1: Upload Helm Chart ─────────────────────────────────────────────────
  app.post("/api/sessions/:id/upload-helm-chart", optionalAuth, validateRequest({ params: sessionIdParams, body: uploadHelmChartBody }), async (req: AuthenticatedRequest, res) => {
    const sessionId = req.params.id;
    try {
      const session = await storage.getSession(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (!ensureSessionOwnership(session, req, res)) return;

      const form = new formidable.IncomingForm({
        uploadDir: os.tmpdir(),
        keepExtensions: true,
        maxFileSize: 50 * 1024 * 1024, // 50 MB
      });

      const [, files] = await form.parse(req);
      const chartFile = Array.isArray(files.chart) ? files.chart[0] : files.chart;
      if (!chartFile) {
        return res.status(400).json({ error: 'No chart file uploaded. Use field name "chart".' });
      }
      const originalName = (chartFile.originalFilename ?? '').toLowerCase();
      const isSupportedArchive = originalName.endsWith('.tgz') || originalName.endsWith('.tar.gz');
      if (!isSupportedArchive) {
        return res.status(400).json({
          error: "Invalid chart format",
          details: "Only packaged Helm chart archives are supported (.tgz or .tar.gz)."
        });
      }

      const uploadedPath = chartFile.filepath ?? (chartFile as any).path;
      console.log(`📦 Helm chart uploaded: ${chartFile.originalFilename ?? 'unknown'} → ${uploadedPath}`);

      // Validate the uploaded chart
      const { validateHelmChart } = await import('../kubernetes/helm-validation-service');
      const result = await validateHelmChart(uploadedPath, {
        runHelmLint: true,
        runKubeval: false,  // skip kubeval for raw archive — helm lint is sufficient
        runCheckov: false,
        runBestPractices: false,
      });

      // Store the chart path in session for subsequent validation
      await storage.updateSession(sessionId, { helmChartPath: uploadedPath } as any);

      res.json({
        success: true,
        fileName: chartFile.originalFilename,
        chartPath: uploadedPath,
        validation: result,
      });
    } catch (error: any) {
      console.error('❌ Helm chart upload failed:', error);
      res.status(500).json({ error: 'Failed to upload Helm chart', details: error.message });
    }
  });

  // ─── D4: Build Kustomize Overlay ──────────────────────────────────────────
  app.post("/api/sessions/:id/build-kustomize", validateRequest({ params: sessionIdParams, body: buildKustomizeBody }), async (req, res) => {
    const sessionId = req.params.id;
    try {
      const session = await storage.getSession(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const { kustomizationDir } = req.body;
      if (!kustomizationDir || typeof kustomizationDir !== 'string') {
        return res.status(400).json({ error: 'kustomizationDir is required' });
      }

      const result = await buildKustomize(kustomizationDir);

      // Persist rendered manifests as session files
      if (result.success && result.manifests.length > 0) {
        for (let i = 0; i < result.manifests.length; i++) {
          const manifestYAML = result.manifests[i];
          try {
            const yaml = await import('js-yaml');
            const parsed = yaml.load(manifestYAML) as any;
            const kind = parsed?.kind ?? 'resource';
            const name = parsed?.metadata?.name ?? i;
            await storage.createFile({
              sessionId,
              fileName: `${kind.toLowerCase()}-${name}.yaml`,
              content: manifestYAML,
            });
          } catch {
            await storage.createFile({
              sessionId,
              fileName: `resource-${i}.yaml`,
              content: manifestYAML,
            });
          }
        }
      }

      res.json(result);
    } catch (error: any) {
      console.error('❌ Kustomize build failed:', error);
      res.status(500).json({ error: 'Failed to build Kustomize overlay', details: error.message });
    }
  });

  // ─── E1: Security Context Score ──────────────────────────────────────────
  app.post("/api/sessions/:id/security-score", validateRequest({ params: sessionIdParams, body: securityScoreBody }), async (req, res) => {
    const sessionId = req.params.id;
    try {
      const session = await storage.getSession(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const files = await storage.getFilesBySession(sessionId);
      const yamlFiles = files.filter(f =>
        f.fileName.endsWith('.yaml') || f.fileName.endsWith('.yml')
      );

      if (yamlFiles.length === 0) {
        return res.status(400).json({ error: 'No YAML files found in session' });
      }

      const manifests = yamlFiles.map(f => f.content);
      const score = await scoreSecurityContexts(manifests);

      // Also run policy hints
      const policyResults = await checkPolicyHints(manifests);

      res.json({ success: true, score, policyResults });
    } catch (error: any) {
      console.error('❌ Security scoring failed:', error);
      res.status(500).json({ error: 'Failed to calculate security score', details: error.message });
    }
  });

  // ─── E3: Policy Hints (list static library) ──────────────────────────────
  app.get("/api/kubernetes/policy-hints", async (_req, res) => {
    try {
      // Policy hints are now AI-generated per-manifest, not a static library.
      // Return empty array for the listing endpoint; use POST /policy-check for actual analysis.
      res.json({ success: true, hints: [] });
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to load policy hints', details: error.message });
    }
  });

  // ─── E3: Check policy hints against session files ─────────────────────────
  app.post("/api/sessions/:id/policy-check", validateRequest({ params: sessionIdParams, body: policyCheckBody }), async (req, res) => {
    const sessionId = req.params.id;
    try {
      const session = await storage.getSession(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const files = await storage.getFilesBySession(sessionId);
      const manifests = files
        .filter(f => f.fileName.endsWith('.yaml') || f.fileName.endsWith('.yml'))
        .map(f => f.content);

      if (manifests.length === 0) {
        return res.status(400).json({ error: 'No YAML files found in session' });
      }

      const results = await checkPolicyHints(manifests);
      res.json({ success: true, totalViolations: results.reduce((s, r) => s + r.violations.length, 0), results });
    } catch (error: any) {
      console.error('❌ Policy check failed:', error);
      res.status(500).json({ error: 'Failed to run policy check', details: error.message });
    }
  });

  // K8s resource rightsizing
  app.post("/api/sessions/:id/rightsize-kubernetes", optionalAuth, validateRequest({ params: sessionIdParams, body: rightsizeK8sBody }), async (req: AuthenticatedRequest, res) => {
    try {
      const sessionId = req.params.id;
      const session = await storage.getSession(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const files = await storage.getFilesBySession(sessionId);
      const yamlFiles = files
        .filter(f => f.fileName.endsWith('.yaml') || f.fileName.endsWith('.yml'))
        .map(f => ({ fileName: f.fileName, content: f.content }));

      if (yamlFiles.length === 0) {
        return res.json({ success: true, result: { recommendations: [], totalContainersAnalysed: 0, totalWorkloadsAnalysed: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 } });
      }

      const result = await generateK8sRightsizingRecommendations(yamlFiles);
      res.json({ success: true, result });
    } catch (error: any) {
      console.error('K8s rightsizing error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // K8s cost estimation
  app.post("/api/sessions/:id/estimate-k8s-cost", optionalAuth, validateRequest({ params: sessionIdParams, body: estimateK8sCostBody }), async (req: AuthenticatedRequest, res) => {
    try {
      const sessionId = req.params.id;
      const session = await storage.getSession(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const files = await storage.getFilesBySession(sessionId);
      if (files.length === 0) return res.json({ success: true, result: { breakdown: [], totalMonthlyCost: 0, totalYearlyCost: 0, currency: 'USD', totalContainers: 0, totalWorkloads: 0, recommendations: [] } });

      const yamlFiles = files
        .filter(f => f.fileName.endsWith('.yaml') || f.fileName.endsWith('.yml'))
        .map(f => ({ fileName: f.fileName, content: f.content }));

      const result = await estimateKubernetesCost(yamlFiles);
      res.json({ success: true, result });
    } catch (error: any) {
      console.error('K8s cost estimation error:', error);
      res.status(500).json({ error: error.message });
    }
  });
}

