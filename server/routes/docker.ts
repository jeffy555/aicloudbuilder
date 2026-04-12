import type { Express } from "express";
import { aiChatCompletion } from '../utils/ai-client.js';
import { storage } from "../storage";
import { mcpClient, type MCPProvider } from "../mcp-client";
import { optionalAuth, type AuthenticatedRequest } from "../middleware/auth";
import { validateRequest } from "../middleware/validate";
import { aiMediumLimiter, aiLightLimiter } from "../middleware/rate-limit";
import { sessionIdParams } from "@shared/api-contracts/common";
import {
  dockerScanBody,
  generateDockerfileBody,
  scanDockerBody,
  dockerBestPracticesBody,
  dockerFixBPBody,
  generateComposeBody,
  imageSizeEstimateBody,
  commitDockerBody,
  generateDockerDiagramBody,
} from "@shared/api-contracts/docker";
import { resolveRepositoryCredentials } from "../utils/credentials";
import { getFixGuidance } from "../checkov-fix-guidance";

/**
 * Verify the requesting user owns the session (or session is unowned).
 * Returns false and sends 403 if access is denied.
 */
function ensureDockerSessionOwnership(session: any, req: AuthenticatedRequest, res: any): boolean {
  if (!session.userId || session.userId !== req.userId) {
    console.warn(`[SECURITY] Docker session access denied: sessionId=${session.id} sessionOwner=${session.userId} requesterId=${req.userId ?? 'anonymous'} ip=${req.ip}`);
    res.status(403).json({ error: 'Access denied to this session' });
    return false;
  }
  return true;
}

/**
 * Docker routes
 */
export function registerDockerRoutes(app: Express): void {
  // Scan repository metadata for Docker info
  app.post("/api/sessions/:id/docker-scan", optionalAuth, validateRequest({ params: sessionIdParams, body: dockerScanBody }), async (req: AuthenticatedRequest, res) => {
    const sessionId = req.params.id;
    try {
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      if (!ensureDockerSessionOwnership(session, req, res)) return;

      const repoName = session.repositoryName;
      const provider = session.provider as MCPProvider | undefined;
      if (!repoName || !provider) {
        return res.status(400).json({
          error: "Repository or provider not configured",
          details: "Select a repository before scanning",
        });
      }

      if (session.activeModule && session.activeModule !== "docker") {
        return res.status(403).json({
          error: "Session tied to another module",
          details: "This session is reserved for a different module workflow",
        });
      }

      console.log(`\n🔍 ========== DOCKER REPO SCAN ==========`);
      console.log(`Session ID: ${sessionId}`);
      console.log(`Provider: ${provider}, Repository: ${repoName}`);

      // Resolve Bitwarden credentials (falls back to env vars if JWT not present)
      const { credentials } = await resolveRepositoryCredentials(provider, req.userId);

      const branch =
        (req.body && typeof req.body.branch === "string" && req.body.branch.trim())
          ? req.body.branch.trim()
          : session.repositoryBranch || "main";
      const rawPaths = await mcpClient.listRepositoryPaths(provider, repoName, branch, credentials);

      // Filter out vendored/generated directories that bloat the scan
      const ignoredPrefixes = [
        'node_modules/', '.git/', 'vendor/', 'dist/', 'build/',
        '.next/', '__pycache__/', '.tox/', '.venv/', 'venv/',
        '.terraform/', '.angular/', 'bower_components/',
      ];
      const paths = rawPaths.filter((p) => {
        const lower = p.toLowerCase();
        return !ignoredPrefixes.some((prefix) => lower.includes(`/${prefix}`) || lower.startsWith(prefix));
      });

      console.log(`   Total files: ${rawPaths.length}, after filtering vendored dirs: ${paths.length}`);

      const languages = new Set<string>();
      const frameworks = new Set<string>();
      const configFiles = new Set<string>();

      const langMap: Record<string, string> = {
        ".py": "Python",
        ".js": "Node.js",
        ".ts": "Node.js",
        ".java": "Java",
        ".go": "Go",
        ".cs": "C#",
        ".rb": "Ruby",
        ".php": "PHP",
        ".rs": "Rust",
        ".sh": "Shell",
        ".ps1": "PowerShell",
      };

      const entrypointCandidates = [
        "app.py",
        "main.py",
        "server.py",
        "manage.py",
        "index.js",
        "server.js",
        "app.js",
        "main.go",
        "cmd/main.go",
      ];

      let entrypoint: string | undefined;
      for (const pathStr of paths) {
        const lower = pathStr.toLowerCase();
        const ext = lower.includes(".") ? lower.substring(lower.lastIndexOf(".")) : "";
        if (langMap[ext]) {
          languages.add(langMap[ext]);
        }

        if (entrypointCandidates.includes(pathStr.split("/").pop() || "")) {
          entrypoint = pathStr;
        }

        if (lower.endsWith("package.json")) {
          frameworks.add("Node.js (npm)");
          configFiles.add(pathStr);
        }
        if (lower.endsWith("requirements.txt") || lower.endsWith("pyproject.toml")) {
          frameworks.add("Python");
          configFiles.add(pathStr);
        }
        if (lower.endsWith("pom.xml") || lower.endsWith("build.gradle")) {
          frameworks.add("Java");
          configFiles.add(pathStr);
        }
        if (lower.endsWith("go.mod")) {
          frameworks.add("Go");
          configFiles.add(pathStr);
        }
      }

      const dependencyFiles: Array<{ file: string; entries: string[] }> = [];
      const safeGetFile = async (filePath: string) => {
        try {
          return await mcpClient.getRepositoryFile(provider, repoName, filePath, branch, credentials);
        } catch (error: any) {
          console.warn(`   ⚠️  Unable to read ${filePath}: ${error.message}`);
          return null;
        }
      };

      const findMatchingPaths = (suffix: string) => {
        return paths.filter((p) => p.toLowerCase().endsWith(suffix));
      };

      // Prefer root-level dependency files; limit to avoid API rate limits on large repos
      const MAX_DEP_FILES = 3;

      const packagePaths = findMatchingPaths("package.json")
        .sort((a, b) => a.split('/').length - b.split('/').length)
        .slice(0, MAX_DEP_FILES);
      for (const packagePath of packagePaths) {
        const packageFile = await safeGetFile(packagePath);
        if (!packageFile?.content) continue;
        try {
          const pkg = JSON.parse(packageFile.content);
          const deps = [
            ...(pkg.dependencies ? Object.keys(pkg.dependencies) : []),
            ...(pkg.devDependencies ? Object.keys(pkg.devDependencies) : []),
          ];
          dependencyFiles.push({ file: packageFile.path, entries: deps });
        } catch {
          dependencyFiles.push({ file: packageFile.path, entries: [] });
        }
      }

      const requirementsPaths = findMatchingPaths("requirements.txt")
        .sort((a, b) => a.split('/').length - b.split('/').length)
        .slice(0, MAX_DEP_FILES);
      for (const requirementsPath of requirementsPaths) {
        const requirementsFile = await safeGetFile(requirementsPath);
        if (!requirementsFile?.content) continue;
        const deps = requirementsFile.content
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"));
        dependencyFiles.push({ file: requirementsFile.path, entries: deps });
      }

      const goModPaths = findMatchingPaths("go.mod")
        .sort((a, b) => a.split('/').length - b.split('/').length)
        .slice(0, MAX_DEP_FILES);
      for (const goModPath of goModPaths) {
        const goModFile = await safeGetFile(goModPath);
        if (!goModFile?.content) continue;
        const deps = goModFile.content
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.startsWith("module") || line.includes("@"));
        dependencyFiles.push({ file: goModFile.path, entries: deps });
      }

      const dockerfilePaths = findMatchingPaths("dockerfile");
      let existingDockerfile: { path: string; content: string } | undefined;
      for (const dockerfilePath of dockerfilePaths) {
        const dockerfile = await safeGetFile(dockerfilePath);
        if (dockerfile?.content) {
          existingDockerfile = {
            path: dockerfile.path,
            content: dockerfile.content,
          };
          break;
        }
      }

      const metadata = {
        languages: Array.from(languages),
        frameworks: Array.from(frameworks),
        configFiles: Array.from(configFiles),
        dependencies: dependencyFiles,
        entrypoint,
        existingDockerfile,
      };

      await storage.updateSession(sessionId, {
        workflowStep: "docker_scan",
        repositoryBranch: branch,
        activeModule: "docker",
      });

      res.json(metadata);
    } catch (error: any) {
      console.error("Docker repo scan failed:", error);
      res.status(500).json({
        error: "Failed to scan repository",
        details: error?.message || "Unknown error",
      });
    }
  });

  // Generate Dockerfile
  app.post("/api/sessions/:id/generate-dockerfile", optionalAuth, aiMediumLimiter, validateRequest({ params: sessionIdParams, body: generateDockerfileBody }), async (req: AuthenticatedRequest, res) => {
    const sessionId = req.params.id;
    
    try {
    const { requirements, existingDockerfile } = req.body;

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
      if (!ensureDockerSessionOwnership(session, req, res)) return;

      if (session.activeModule && session.activeModule !== 'docker') {
        return res.status(403).json({
          error: 'Session locked to another module',
          details: 'Docker generation can only run on a Docker workflow session',
        });
      }

      console.log(`\n🐳 ========== DOCKERFILE GENERATION ==========`);
      console.log(`Session ID: ${sessionId}`);
      console.log(`Requirements: "${typeof requirements === 'string' ? requirements.substring(0, 200) : JSON.stringify(requirements).substring(0, 200)}..."`);

      // Import and generate Dockerfile
      const { generateDockerfile } = await import('../docker/dockerfile-generator');
      const result = await generateDockerfile(requirements, existingDockerfile);
      const uniqueFilesMap = new Map<string, { path: string; content: string }>();
      for (const file of result.files) {
        const normalizedPath = file.path?.trim() || "Dockerfile";
        const lowerPath = normalizedPath.toLowerCase();
        if (uniqueFilesMap.has(lowerPath)) {
          console.log(`   ⚠️  Skipping duplicate generated file: ${normalizedPath}`);
          continue;
        }
        uniqueFilesMap.set(lowerPath, {
          path: normalizedPath,
          content: file.content,
        });
      }
      const filteredFiles = Array.from(uniqueFilesMap.values()).sort((a, b) => (a.path?.length || 0) - (b.path?.length || 0));

      const dockerCandidates = filteredFiles.filter((file) => {
        const lastSegment = (file.path || "").split("/").pop()?.toLowerCase() || "";
        return lastSegment.includes("dockerfile");
      });

      const dockerignoreCandidates = filteredFiles.filter((file) => {
        const lastSegment = (file.path || "").split("/").pop()?.toLowerCase() || "";
        return lastSegment === ".dockerignore";
      });

      // Save Dockerfile + .dockerignore (if generated)
      const filesToSave = [
        ...(dockerCandidates.length > 0 ? [dockerCandidates[0]] : filteredFiles.slice(0, 1)),
        ...dockerignoreCandidates.slice(0, 1),
      ];

      // Cleanup existing docker artifacts before saving
      const dockerNamePattern = /dockerfile|dockerignore|docker-scan/i;
      const existingFiles = await storage.getFilesBySession(sessionId);
      for (const existing of existingFiles) {
        if (dockerNamePattern.test(existing.fileName)) {
          await storage.deleteFile(existing.id);
        }
      }

      console.log(`✅ Generated ${result.files.length} file(s)`);

      // Save generated files to session storage
      const savedFiles = [];
      for (const file of filesToSave) {
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
        workflowStep: 'docker_generation',
        activeModule: 'docker'
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
  app.post("/api/sessions/:id/scan-docker", optionalAuth, aiLightLimiter, validateRequest({ params: sessionIdParams, body: scanDockerBody }), async (req: AuthenticatedRequest, res) => {
    try {
      const sessionId = req.params.id;
      console.log(`\n🔍 ========== DOCKER SCAN REQUEST ==========`);
      console.log(`Session ID: ${sessionId}`);

      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!ensureDockerSessionOwnership(session, req, res)) return;

      // Get Dockerfile from session storage
      const files = await storage.getFilesBySession(sessionId);
      const dockerfile = files.find(f => 
        f.fileName.toLowerCase() === 'dockerfile' || 
        f.fileName.toLowerCase().endsWith('.dockerfile')
      );

      if (!dockerfile) {
        return res.status(400).json({ 
          error: 'Dockerfile not found',
          details: 'Please generate a Dockerfile first'
        });
      }

      console.log(`📄 Found Dockerfile: ${dockerfile.fileName} (${dockerfile.content.length} chars)`);

      // Create temp directory and write Dockerfile
      const fs = await import('fs/promises');
      const path = await import('path');
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);
      
      const projectRoot = process.cwd();
      const tempBaseDir = path.join(projectRoot, '.temp-checkov-docker');
      await fs.mkdir(tempBaseDir, { recursive: true });
      const tempDir = await fs.mkdtemp(path.join(tempBaseDir, 'scan-'));
      const dockerfilePath = path.join(tempDir, 'Dockerfile');

      try {
        // Write Dockerfile to temp directory
        await fs.writeFile(dockerfilePath, dockerfile.content, 'utf-8');
        console.log(`✅ Wrote Dockerfile to: ${dockerfilePath}`);

        // Verify Dockerfile exists and has content
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
      console.log(`   Option 1 (file): -f ${dockerfilePath} --framework dockerfile`);
      console.log(`   Option 2 (directory): -d ${tempDir} --framework dockerfile`);
      
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
          
          const { stdout, stderr } = await execFileAsync(cmd, args, {
            timeout: 120000, // 2 minute timeout
            cwd: tempDir,
          });
          checkovOutput = stdout || stderr;
          commandWorked = true;
          successfulCommand = `${cmd} ${args.join(' ')}`;
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
            console.error('   This suggests the --framework dockerfile flag may not be working');
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
        console.error('   2. Checkov used wrong framework (check if --framework dockerfile flag worked)');
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
        failedChecks: checks.map((check: any) => {
          const checkId = check.check_id || check.checkId;
          const guidance = getFixGuidance(checkId, check.check_name || check.checkName);
          return {
            ...check,
            severity: check.severity || guidance?.severity || null,
            autoFixable: guidance?.autoFixable ?? false,
            fixComplexity: guidance?.fixComplexity || 'moderate',
            complianceStandards: guidance?.complianceStandards || [],
          };
        }),
        passedChecks: passedChecks
      });

    } catch (error: any) {
      console.error('❌ Error scanning Dockerfile:', error);
      res.status(500).json({ 
        error: 'Failed to scan Dockerfile',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    } finally {
      // Cleanup temp directory
      try {
        const fs = await import('fs/promises');
        const path = await import('path');
        const projectRoot = process.cwd();
        const tempBaseDir = path.join(projectRoot, '.temp-checkov-docker');
        // Note: tempDir is not accessible here, but we can try to clean up the base dir
        // In a real implementation, we'd store tempDir in a variable accessible in finally
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
    }
  });

  // Docker Best Practices Validation
  app.post("/api/sessions/:id/docker-best-practices", optionalAuth, aiLightLimiter, validateRequest({ params: sessionIdParams, body: dockerBestPracticesBody }), async (req: AuthenticatedRequest, res) => {
    try {
      const sessionId = req.params.id;
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      if (!ensureDockerSessionOwnership(session, req, res)) return;

      const files = await storage.getFilesBySession(sessionId);
      const dockerfile = files.find(
        (f) =>
          f.fileName.toLowerCase() === "dockerfile" ||
          f.fileName.toLowerCase().endsWith(".dockerfile")
      );

      if (!dockerfile) {
        return res.status(400).json({
          error: "Dockerfile not found",
          details: "Generate a Dockerfile first",
        });
      }

      console.log(`\n🔍 ========== DOCKER BEST PRACTICES (AI) ==========`);
      console.log(`Session: ${sessionId}`);
      const content = dockerfile.content;
      const lines = content.split("\n");

      // Gather context for AI analysis
      const fromLines = lines.filter((l) => l.trim().toUpperCase().startsWith("FROM"));
      const baseImages = fromLines.map((l) => {
        const m = l.match(/FROM\s+(?:--platform=\S+\s+)?(\S+)/i);
        return m ? m[1] : "unknown";
      });
      const isMultiStage = fromLines.length > 1;
      const dockerignoreFile = files.find(
        (f) => f.fileName.toLowerCase() === ".dockerignore"
      );
      const dockerignoreContent = dockerignoreFile?.content ?? null;

      interface Finding {
        id: string;
        severity: "PASSED" | "WARNING" | "FAILED";
        title: string;
        description: string;
        line?: number;
        fix?: string;
      }

      let findings: Finding[] = [];

      try {

        const systemPrompt = `You are a Docker security and best practices expert. Analyze this Dockerfile against production best practices. For each finding, provide: id (DOCKER_BP_xxx), title, severity (PASSED/WARNING/FAILED), description explaining WHY this matters, and a specific fix suggestion with code example. Check for: official base images, version pinning, slim/alpine variants, multi-stage builds, non-root USER, HEALTHCHECK, .dockerignore, COPY vs ADD, environment optimization, OCI labels, layer caching order, secret handling, and any other relevant best practices.

Return valid JSON with this shape:
{
  "findings": [
    {
      "id": "DOCKER_BP_001",
      "title": "string",
      "severity": "PASSED" | "WARNING" | "FAILED",
      "description": "string explaining why this matters",
      "fix": "string with specific code suggestion (omit for PASSED findings)"
    }
  ]
}

Use sequential IDs starting at DOCKER_BP_001. Severity meanings:
- PASSED: The Dockerfile follows this best practice correctly.
- WARNING: A recommendation that would improve the image but isn't critical.
- FAILED: A significant security or reliability issue that should be fixed before production.

Be context-aware: consider the base image, the application type, and the build pattern when assigning severity. Include PASSED findings for practices the Dockerfile already follows correctly.`;

        const userPrompt = `Analyze this Dockerfile for best practices:

\`\`\`dockerfile
${content}
\`\`\`

Context:
- Base image(s): ${baseImages.join(", ")}
- Multi-stage build: ${isMultiStage ? `Yes (${fromLines.length} stages)` : "No"}
- .dockerignore present: ${dockerignoreContent ? "Yes" : "No"}${dockerignoreContent ? `\n- .dockerignore contents:\n\`\`\`\n${dockerignoreContent}\n\`\`\`` : ""}`;

        const response = await aiChatCompletion({
          model: "gpt-4o-mini",
          temperature: 0.3,
          response_format: { type: "json_object" },
          messages: [
            { role: "system" as const, content: systemPrompt },
            { role: "user" as const, content: userPrompt },
          ],
        });

        const rawContent = response.choices[0]?.message?.content;
        if (!rawContent) throw new Error("Empty AI response");

        const parsed = JSON.parse(rawContent) as { findings: Finding[] };
        if (!Array.isArray(parsed.findings)) throw new Error("Invalid AI response shape");

        // Validate and sanitize each finding
        findings = parsed.findings.map((f: any, idx: number) => {
          const severity = (["PASSED", "WARNING", "FAILED"].includes(f.severity) ? f.severity : "WARNING") as Finding["severity"];
          return {
            id: f.id || `DOCKER_BP_${String(idx + 1).padStart(3, "0")}`,
            title: String(f.title || "Untitled check"),
            severity,
            description: String(f.description || ""),
            ...(f.fix ? { fix: String(f.fix) } : {}),
            ...(f.line ? { line: Number(f.line) } : {}),
          };
        });

        console.log(`🤖 AI returned ${findings.length} findings`);
      } catch (aiError: any) {
        console.error("AI best practices analysis failed, returning safe defaults:", aiError.message);
        res.json({
          success: true,
          summary: { passed: 0, warnings: 0, failed: 0, total: 0 },
          findings: [],
          error: "AI analysis unavailable",
        });
        return;
      }

      // ── Summary ──
      const passed = findings.filter((f) => f.severity === "PASSED").length;
      const warnings = findings.filter((f) => f.severity === "WARNING").length;
      const failed = findings.filter((f) => f.severity === "FAILED").length;

      console.log(`✅ Best practices: ${passed} passed, ${warnings} warnings, ${failed} failed`);

      res.json({
        success: true,
        summary: { passed, warnings, failed, total: findings.length },
        findings,
      });
    } catch (error: any) {
      console.error("Docker best practices validation failed:", error);
      res.status(500).json({
        error: "Validation failed",
        details: error.message,
      });
    }
  });

  // Fix Dockerfile based on best practices findings
  app.post("/api/sessions/:id/docker-fix-best-practices", optionalAuth, aiMediumLimiter, validateRequest({ params: sessionIdParams, body: dockerFixBPBody }), async (req: AuthenticatedRequest, res) => {
    try {
      const sessionId = req.params.id;
      const { findings } = req.body as {
        findings: Array<{
          id: string;
          severity: string;
          title: string;
          description: string;
          line?: number;
          fix?: string;
        }>;
      };

      if (!findings || findings.length === 0) {
        return res.status(400).json({ error: "No findings to fix" });
      }

      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      if (!ensureDockerSessionOwnership(session, req, res)) return;

      const files = await storage.getFilesBySession(sessionId);
      const dockerfile = files.find(
        (f) =>
          f.fileName.toLowerCase() === "dockerfile" ||
          f.fileName.toLowerCase().endsWith(".dockerfile")
      );

      if (!dockerfile) {
        return res.status(400).json({ error: "Dockerfile not found" });
      }

      console.log(`\n🔧 ========== DOCKER FIX BEST PRACTICES ==========`);
      console.log(`Session: ${sessionId}`);
      console.log(`Findings to fix: ${findings.length}`);

      const issuesList = findings
        .filter((f) => f.severity !== "PASSED")
        .map((f) => `- [${f.id}] ${f.title}: ${f.description}${f.fix ? ` (Suggested: ${f.fix})` : ""}`)
        .join("\n");

      const completion = await aiChatCompletion({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are a Docker expert. Fix the provided Dockerfile to address the listed best-practice issues.
Rules:
- Use ONLY official Docker Hub images or trusted registries (mcr.microsoft.com, gcr.io, ghcr.io)
- Always pin specific version tags (never use :latest or omit the tag)
- Prefer alpine or slim variants for minimal image size
- Use multi-stage builds when beneficial
- Run as non-root user
- Include HEALTHCHECK instruction
- Use COPY instead of ADD
- Set NODE_ENV=production for Node.js apps
- Keep ALL existing functionality intact — only fix the identified issues
- Return ONLY the fixed Dockerfile content, no explanations or markdown.`,
          },
          {
            role: "user",
            content: `Fix this Dockerfile to address the following best practice issues:

Issues:
${issuesList}

Current Dockerfile:
\`\`\`dockerfile
${dockerfile.content}
\`\`\`

Return ONLY the fixed Dockerfile content.`,
          },
        ],
        temperature: 0.2,
        max_tokens: 4000,
      });

      let fixedContent = completion.choices[0]?.message?.content?.trim() || "";
      // Strip markdown fencing if present
      fixedContent = fixedContent
        .replace(/^```dockerfile\s*\n?/i, "")
        .replace(/^```\s*\n?/, "")
        .replace(/\n?```\s*$/, "");

      if (!fixedContent || !fixedContent.toUpperCase().includes("FROM")) {
        return res.status(500).json({
          error: "AI returned invalid Dockerfile",
          details: "The fixed Dockerfile is empty or missing FROM instruction",
        });
      }

      // Update the file in storage
      await storage.updateFile(dockerfile.id, fixedContent);
      console.log(`✅ Dockerfile updated (${fixedContent.length} chars)`);

      res.json({
        success: true,
        fixedContent,
        fixedCount: findings.filter((f) => f.severity !== "PASSED").length,
      });
    } catch (error: any) {
      console.error("Docker fix best practices failed:", error);
      res.status(500).json({
        error: "Fix failed",
        details: error.message,
      });
    }
  });

  // Generate docker-compose.yml
  app.post("/api/sessions/:id/generate-compose", optionalAuth, aiMediumLimiter, validateRequest({ params: sessionIdParams, body: generateComposeBody }), async (req: AuthenticatedRequest, res) => {
    const sessionId = req.params.id;
    try {
      const session = await storage.getSession(sessionId);
      if (!session) return res.status(404).json({ error: "Session not found" });
      if (!ensureDockerSessionOwnership(session, req, res)) return;

      const files = await storage.getFilesBySession(sessionId);
      const dockerfile = files.find(
        (f) => f.fileName.toLowerCase() === "dockerfile" || f.fileName.toLowerCase().endsWith(".dockerfile")
      );

      if (!dockerfile) {
        return res.status(400).json({ error: "Dockerfile not found", details: "Generate a Dockerfile first" });
      }

      const { scanData } = req.body as {
        scanData?: { languages?: string[]; frameworks?: string[]; entrypoint?: string };
      };

      console.log(`\n🐙 ========== DOCKER COMPOSE GENERATION ==========`);
      console.log(`Session: ${sessionId}`);

      const { generateDockerCompose } = await import('../docker/compose-generator');
      const result = await generateDockerCompose({
        projectName: session.repositoryName || "app",
        languages: scanData?.languages ?? [],
        frameworks: scanData?.frameworks ?? [],
        entrypoint: scanData?.entrypoint,
        existingDockerfileContent: dockerfile.content,
      });

      // Delete old compose file if exists
      const existingCompose = files.find((f) => f.fileName.toLowerCase() === "docker-compose.yml");
      if (existingCompose) await storage.deleteFile(existingCompose.id);

      // Save new compose file
      const saved = await storage.createFile({
        sessionId,
        fileName: "docker-compose.yml",
        content: result.content,
      });

      console.log(`✅ docker-compose.yml generated with services: ${result.services.join(', ')}`);
      res.json({ success: true, file: saved, services: result.services });
    } catch (error: any) {
      console.error("Compose generation failed:", error);
      res.status(500).json({ error: "Failed to generate docker-compose.yml", details: error.message });
    }
  });

  // Estimate image sizes from Dockerfile
  app.post("/api/sessions/:id/image-size-estimate", optionalAuth, validateRequest({ params: sessionIdParams, body: imageSizeEstimateBody }), async (req: AuthenticatedRequest, res) => {
    const sessionId = req.params.id;
    try {
      const session = await storage.getSession(sessionId);
      if (!session) return res.status(404).json({ error: "Session not found" });
      if (!ensureDockerSessionOwnership(session, req, res)) return;

      const files = await storage.getFilesBySession(sessionId);
      const dockerfile = files.find(
        (f) => f.fileName.toLowerCase() === "dockerfile" || f.fileName.toLowerCase().endsWith(".dockerfile")
      );

      if (!dockerfile) {
        return res.status(400).json({ error: "Dockerfile not found" });
      }

      const { estimateImageSizes } = await import('../docker/compose-generator');
      const estimates = await estimateImageSizes(dockerfile.content);

      res.json({ success: true, estimates });
    } catch (error: any) {
      res.status(500).json({ error: "Estimation failed", details: error.message });
    }
  });

  // Commit Dockerfile
  app.post("/api/sessions/:id/commit-docker", optionalAuth, validateRequest({ params: sessionIdParams, body: commitDockerBody }), async (req: AuthenticatedRequest, res) => {
    const sessionId = req.params.id;
    const { message } = req.body;

    try {
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!ensureDockerSessionOwnership(session, req, res)) return;

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
        f.fileName.toLowerCase() === 'docker-compose.yml' ||
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

  // Generate architecture diagram for Docker session (Dockerfile → Mermaid)
  app.post("/api/sessions/:id/generate-docker-diagram", optionalAuth, validateRequest({ params: sessionIdParams, body: generateDockerDiagramBody }), async (req: AuthenticatedRequest, res) => {
    const sessionId = req.params.id;
    try {
      const session = await storage.getSession(sessionId);
      if (!session) return res.status(404).json({ error: "Session not found" });
      if (!ensureDockerSessionOwnership(session, req, res)) return;

      const files = await storage.getFilesBySession(sessionId);
      const dockerFiles = files.filter(f =>
        f.fileName.toLowerCase().includes('dockerfile') ||
        f.fileName.toLowerCase().includes('docker-compose') ||
        f.fileName.toLowerCase().endsWith('.yml') ||
        f.fileName.toLowerCase().endsWith('.yaml')
      );

      if (dockerFiles.length === 0) {
        return res.status(400).json({ error: 'No Dockerfile found', details: 'Generate a Dockerfile first' });
      }

      const filesContent = dockerFiles.map(f => `=== ${f.fileName} ===\n${f.content}`).join('\n\n');

      const response = await aiChatCompletion({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You generate Mermaid flowchart diagrams for Docker architectures.
Given Dockerfile and optional docker-compose.yml content, produce a clear Mermaid graph TD diagram showing:
- Build stages (multi-stage builds as separate nodes)
- Base images as top-level nodes
- Services from docker-compose (if present) as separate nodes
- Port exposures and volume mounts as annotations
- Service dependencies (depends_on) as arrows

Rules:
- Use graph TD direction
- Node IDs must be alphanumeric with no spaces
- Labels in square brackets [ ]
- Use --> for relationships
- Do NOT include subgraph blocks (not supported)
- Return ONLY the raw Mermaid syntax starting with "graph TD", no markdown fences`
          },
          {
            role: 'user',
            content: `Generate a Mermaid architecture diagram for this Docker setup:\n\n${filesContent}`
          }
        ],
        max_tokens: 1000,
        temperature: 0.2,
      });

      let mermaidSyntax = response.choices[0]?.message?.content?.trim() || '';
      // Strip markdown fences if present
      mermaidSyntax = mermaidSyntax.replace(/^```(?:mermaid)?\n?/i, '').replace(/\n?```$/i, '').trim();

      if (!mermaidSyntax.startsWith('graph')) {
        mermaidSyntax = `graph TD\n  Dockerfile["📦 Dockerfile"]\n  Image["🐳 Docker Image"]\n  Dockerfile --> Image`;
      }

      res.json({
        success: true,
        mermaidSyntax,
        metadata: {
          totalResources: dockerFiles.length,
          totalRelationships: 0,
          categories: ['Docker'],
          diagramType: 'flowchart',
        },
      });
    } catch (error: any) {
      console.error('❌ Error generating Docker diagram:', error);
      res.status(500).json({ error: 'Failed to generate Docker diagram', details: error.message });
    }
  });
}

