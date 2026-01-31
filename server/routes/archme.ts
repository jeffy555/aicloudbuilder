/**
 * ArchMe-specific API routes
 * Handles architecture analysis, component extraction, code generation, and diagram creation
 */

import { spawn } from "child_process";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import type { Express, Response } from "express";
import sharp from "sharp";
import { storage } from "../storage";
import { mcpClient, type MCPProvider } from "../mcp-client";
import { analyzeArchitectureRequirements } from "../diagram/architecture-analyzer";
import { generateArchitectureDiagram as generateArchDiagramFromAnalysis } from "../diagram/architecture-diagram-generator";
import type { DiagramType } from "../diagram/diagram-type-generator";
import { extractComponents } from "../archme/component-extractor";
import { generateAllComponentCode } from "../archme/code-generator";
import { generateReadme } from "../archme/readme-generator";
import { runCheckovKubernetes } from "../kubernetes/checkov-validator";
import { optionalAuth, type AuthenticatedRequest } from "../middleware/auth";

const ARCHME_MODULE_TAG = "archme";
const ARCHME_BANNED_KEYWORDS = [
  "terraform",
  "docker",
  "automation script",
  "scoreme",
  "deploy agent",
  "runbook",
  "weather",
  "trivia",
];

async function getArchMeSession(sessionId: string, res: Response) {
  const session = await storage.getSession(sessionId);
  if (!session) {
    res.status(404).json({
      error: "Session not found",
      details: `Session ${sessionId} does not exist`,
    });
    return null;
  }
  if (session.activeModule && session.activeModule !== ARCHME_MODULE_TAG) {
    res.status(403).json({
      error: "Session reserved for another module",
      details: "This session is already claimed by a different module workflow",
    });
    return null;
  }
  return session;
}

function detectArchMeBannedKeywords(input: string): string[] {
  const normalized = input.toLowerCase();
  return ARCHME_BANNED_KEYWORDS.filter((keyword) => normalized.includes(keyword));
}

async function renderMermaidPng(mermaidCode: string): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "archme-mermaid-"));
  const inputPath = path.join(tmpDir, "diagram.mmd");
  const outputPath = path.join(tmpDir, "diagram.png");

  await fs.writeFile(inputPath, mermaidCode, "utf8");
  await runMermaidCli(inputPath, outputPath, "png");

  try {
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function runMermaidCli(
  inputPath: string,
  outputPath: string,
  format: "svg" | "png" = "svg"
): Promise<void> {
  const binaryName = process.platform === "win32" ? "mmdc.cmd" : "mmdc";
  const binaryPath = path.join(process.cwd(), "node_modules", ".bin", binaryName);
  return new Promise<void>((resolve, reject) => {
    const args = [
      "-i",
      inputPath,
      "-o",
      outputPath,
      "--backgroundColor",
      "#050816",
      "--quiet",
    ];
    if (format) {
      args.push("-e", format);
    }
    const child = spawn(binaryPath, args, {
      env: process.env,
      shell: process.platform === "win32",
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Failed to render Mermaid diagram (exit ${code})${stderr ? `: ${stderr}` : ""}`
          )
        );
      }
    });
  });
}

/**
 * Register ArchMe-specific routes
 */
export function registerArchMeRoutes(app: Express) {
  // Analyze architecture requirements from natural language
  app.post("/api/sessions/:id/analyze-architecture", optionalAuth, async (req: AuthenticatedRequest, res) => {
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
      const session = await getArchMeSession(sessionId, res);
      if (!session) {
        return;
      }

      // Check user access
      if (session.userId && req.userId && session.userId !== req.userId) {
        return res.status(403).json({ error: 'Access denied to this session' });
      }

      const bannedKeywords = detectArchMeBannedKeywords(requirements);
      if (bannedKeywords.length > 0) {
        console.warn(`ArchMe input contains banned keywords: ${bannedKeywords.join(", ")}`);
        return res.status(400).json({
          error: 'Off-scope keywords detected',
          details: `Please remove terms related to other modules: ${bannedKeywords.join(", ")}`
        });
      }

      // Analyze architecture requirements
      const analysis = await analyzeArchitectureRequirements(requirements);

      // Store analysis in session metadata for diagram generation
      await storage.updateSession(sessionId, {
        archMeAnalysis: JSON.stringify(analysis),
        activeModule: ARCHME_MODULE_TAG
      } as any);

      // Send AI message about the analysis
      await storage.createMessage({
        sessionId,
        type: 'ai',
        content: '✅ Architecture analysis complete. Generating diagram...'
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

  // Validate selected repository is empty before ArchMe writes
  app.post("/api/sessions/:id/validate-empty-repo", optionalAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const sessionId = req.params.id;
      const { provider, repositoryName, branch = "main" } = req.body;

      if (!provider || !repositoryName) {
        return res.status(400).json({
          error: "Provider and repository name are required",
          details: "Please select a repository provider and name"
        });
      }

      const session = await getArchMeSession(sessionId, res);
      if (!session) {
        return;
      }

      const paths = await mcpClient.listRepositoryPaths(provider as MCPProvider, repositoryName, branch);
      const isEmpty = paths.length === 0;

      res.json({
        isEmpty,
        fileCount: paths.length,
      });
    } catch (error: any) {
      console.error("❌ Error validating repository emptiness:", error);
      res.status(500).json({
        error: "Failed to validate repository",
        details: error.message || "Unknown error"
      });
    }
  });

  // Generate architecture diagram from analysis (for ArchMe workflow)
  app.post("/api/sessions/:id/generate-architecture-diagram", optionalAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const sessionId = req.params.id;
      const useAI = req.body.useAI !== false; // Default to true
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
      const session = await getArchMeSession(sessionId, res);
      if (!session) {
        return;
      }

      // Check user access
      if (session.userId && req.userId && session.userId !== req.userId) {
        return res.status(403).json({ error: 'Access denied to this session' });
      }

      // Get stored analysis
      const analysisJson = (session as any).archMeAnalysis;
      if (!analysisJson) {
        console.error(`❌ No analysis found for session ${sessionId}`);
        return res.status(400).json({
          error: 'No analysis found',
          details: 'Please analyze architecture requirements first'
        });
      }

      console.log(`📡 Analysis found, length: ${analysisJson.length}. Parsing...`);
      let analysis;
      try {
        analysis = JSON.parse(analysisJson);
      } catch (parseError) {
        console.error(`❌ Failed to parse analysis for session ${sessionId}:`, parseError);
        return res.status(400).json({
          error: 'Invalid analysis data',
          details: 'Failed to parse stored analysis'
        });
      }

      console.log(`📡 Analysis parsed successfully. Calling generator...`);
      // Generate diagram from analysis
      const result = await generateArchDiagramFromAnalysis(analysis, diagramType, useAI);
      console.log(`✅ Generator returned result. Mermaid syntax length: ${result.mermaidSyntax?.length || 0}`);

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

  app.post("/api/sessions/:id/diagram-image", optionalAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const sessionId = req.params.id;
      const requestedDiagramType = req.body?.diagramType as DiagramType | undefined;
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

      const session = await getArchMeSession(sessionId, res);
      if (!session) {
        return;
      }

      if (session.userId && req.userId && session.userId !== req.userId) {
        return res.status(403).json({ error: 'Access denied to this session' });
      }

      const analysisJson = (session as any).archMeAnalysis;
      if (!analysisJson) {
        return res.status(400).json({
          error: 'No analysis found',
          details: 'Generate the diagram first'
        });
      }

      let analysis;
      try {
        analysis = JSON.parse(analysisJson);
      } catch (parseError) {
        return res.status(400).json({
          error: 'Invalid analysis data',
          details: 'Could not parse stored analysis'
        });
      }

      const result = await generateArchDiagramFromAnalysis(analysis, diagramType, true);

      if (!result?.mermaidSyntax || typeof result.mermaidSyntax !== "string") {
        return res.status(500).json({
          error: "Diagram generation failed",
          details: "Mermaid syntax was not produced",
        });
      }

      const pngBuffer = await renderMermaidPng(result.mermaidSyntax);
      const imageBuffer = await sharp(pngBuffer)
        .flatten({ background: "#050816" })
        .jpeg({ quality: 95 })
        .toBuffer();

      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Disposition", `attachment; filename=archme-diagram-${Date.now()}.jpg`);
      res.send(imageBuffer);
    } catch (error: any) {
      console.error('❌ Error exporting diagram image:', error);
      res.status(500).json({
        error: 'Failed to export diagram image',
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
      const session = await getArchMeSession(sessionId, res);
      if (!session) {
        return;
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
      const session = await getArchMeSession(sessionId, res);
      if (!session) {
        return;
      }

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

  // Scan ArchMe generated code with Checkov (uses same logic as Terraform/Kubernetes scan)
  app.post("/api/sessions/:id/scan-archme-code", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const { code } = req.body;
      const session = await getArchMeSession(sessionId, res);
      if (!session) {
        return;
      }

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
      const session = await getArchMeSession(sessionId, res);
      if (!session) {
        return;
      }

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
      const session = await getArchMeSession(sessionId, res);
      if (!session) {
        return;
      }

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
}

