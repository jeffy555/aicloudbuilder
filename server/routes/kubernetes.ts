/**
 * Kubernetes-specific API routes
 * Handles Kubernetes manifest generation, validation, scanning, and diagram generation
 */

import type { Express } from "express";
import OpenAI from 'openai';
import { storage } from "../storage";
import { mcpClient, type MCPProvider } from "../mcp-client";
import { openaiService } from "../openai-service";
import { generateKubernetesManifests } from "../kubernetes/manifest-generator";
import { validateHelmChart } from "../kubernetes/helm-validation-service";
import { generateKubernetesDiagram } from "../kubernetes/diagram-generator";
import { runCheckovKubernetes } from "../kubernetes/checkov-validator";
import { analyzeKubernetesBestPractices } from "../kubernetes/best-practices-analyzer";
import { validateKubernetesYAML } from "../kubernetes/kubeval-validator";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Register Kubernetes-specific routes
 */
export function registerKubernetesRoutes(app: Express) {
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

  // Fix Kubernetes validation issues (best practices + schema)
  app.post("/api/sessions/:id/fix-kubernetes-validation", async (req, res) => {
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

      // Combine all YAML files with their filenames for context
      const yamlWithFiles = yamlFiles.map(f => `# File: ${f.fileName}\n${f.content}`).join('\n---\n');

      // Use AI to fix the issues
      const systemPrompt = `You are an expert Kubernetes engineer. Your task is to fix issues in Kubernetes YAML manifests based on validation findings.

IMPORTANT RULES:
1. Fix ALL the issues listed while preserving the original structure and functionality
2. Apply Kubernetes best practices:
   - Add resource limits and requests if missing
   - Add liveness and readiness probes if missing
   - Add security contexts (runAsNonRoot, readOnlyRootFilesystem, allowPrivilegeEscalation: false)
   - Ensure proper labels and selectors
   - Use appropriate container ports
3. Keep the original resource names and configurations intact
4. Output valid YAML only - no explanations
5. Separate multiple resources with --- on its own line
6. Keep the # File: comment before each resource to indicate which file it belongs to
7. DO NOT add markdown code blocks - output raw YAML only`;

      const issuesList = issues && issues.length > 0
        ? issues.map((i: any) => `- ${i.message || i.issue}`).join('\n')
        : 'Apply all Kubernetes best practices including: resource limits, probes, security contexts, and proper labels';

      const userPrompt = `Fix the following issues in these Kubernetes manifests:

ISSUES TO FIX:
${issuesList}

CURRENT YAML:
${yamlWithFiles}

Return ONLY the fixed YAML with all issues resolved. Keep the # File: comments. No explanations or code blocks.`;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 8000
      });

      let fixedYaml = completion.choices[0]?.message?.content || '';

      // Remove any markdown code blocks if AI added them
      fixedYaml = fixedYaml.replace(/```yaml\n?/gi, '').replace(/```yml\n?/gi, '').replace(/```\n?/g, '').trim();

      if (!fixedYaml) {
        throw new Error('AI failed to generate fixed YAML');
      }

      console.log(`✅ AI generated fixed YAML (${fixedYaml.length} characters)`);

      // Parse the fixed YAML into separate resources
      const fixedResources = fixedYaml
        .split(/^---\s*$/m)
        .map(r => r.trim())
        .filter(r => r.length > 0);

      console.log(`📄 Parsed ${fixedResources.length} resource(s) from fixed YAML`);

      // Import yaml parser
      const yaml = await import('js-yaml');

      // Update each file in storage
      const updatedFiles: Array<{ fileName: string; content: string }> = [];

      for (const resource of fixedResources) {
        try {
          // Extract file name from comment if present
          const fileMatch = resource.match(/^#\s*File:\s*(.+)$/m);
          let fileName: string | null = fileMatch ? fileMatch[1].trim() : null;

          // Remove the file comment for the actual content
          const cleanContent = resource.replace(/^#\s*File:\s*.+\n?/m, '').trim();

          const parsed = yaml.load(cleanContent) as any;
          if (!parsed || !parsed.kind || !parsed.metadata?.name) {
            console.warn('⚠️  Skipping unparseable resource');
            continue;
          }

          // Generate filename if not extracted
          if (!fileName) {
            const sanitizedName = parsed.metadata.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
            fileName = `${sanitizedName}-${parsed.kind.toLowerCase()}.yaml`;
          }

          // Find existing file
          const existingFile = yamlFiles.find(f => f.fileName === fileName);

          if (existingFile) {
            await storage.updateFile(existingFile.id, cleanContent);
            console.log(`   📝 Updated: ${fileName}`);
          } else {
            await storage.createFile({
              sessionId,
              fileName,
              content: cleanContent
            });
            console.log(`   ✨ Created: ${fileName}`);
          }

          updatedFiles.push({ fileName, content: cleanContent });
        } catch (parseError: any) {
          console.warn(`⚠️  Failed to parse resource: ${parseError.message}`);
        }
      }

      console.log(`✅ Fixed ${updatedFiles.length} file(s)`);
      console.log('==========================================\n');

      res.json({
        success: true,
        message: `Fixed ${updatedFiles.length} file(s) with best practices applied`,
        updatedFiles: updatedFiles.map(f => f.fileName),
        totalFixed: updatedFiles.length
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

  // Get fix for Kubernetes security issue (RAG-based retrieval)
  app.post("/api/sessions/:id/kubernetes-fix", async (req, res) => {
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
  app.post("/api/sessions/:id/kubernetes-fix/verify", async (req, res) => {
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
  app.post("/api/sessions/:id/kubernetes-fixes/batch", async (req, res) => {
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
}

