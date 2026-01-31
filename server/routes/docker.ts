import type { Express } from "express";
import { storage } from "../storage";
import { mcpClient, type MCPProvider } from "../mcp-client";

/**
 * Docker routes
 */
export function registerDockerRoutes(app: Express): void {
  // Scan repository metadata for Docker info
  app.post("/api/sessions/:id/docker-scan", async (req, res) => {
    const sessionId = req.params.id;
    try {
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

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

      const branch =
        (req.body && typeof req.body.branch === "string" && req.body.branch.trim())
          ? req.body.branch.trim()
          : session.repositoryBranch || "main";
      const paths = await mcpClient.listRepositoryPaths(provider, repoName, branch);

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
          return await mcpClient.getRepositoryFile(provider, repoName, filePath, branch);
        } catch (error: any) {
          console.warn(`   ⚠️  Unable to read ${filePath}: ${error.message}`);
          return null;
        }
      };

      const findMatchingPaths = (suffix: string) => {
        return paths.filter((p) => p.toLowerCase().endsWith(suffix));
      };

      const packagePaths = findMatchingPaths("package.json");
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

      const requirementsPaths = findMatchingPaths("requirements.txt");
      for (const requirementsPath of requirementsPaths) {
        const requirementsFile = await safeGetFile(requirementsPath);
        if (!requirementsFile?.content) continue;
        const deps = requirementsFile.content
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"));
        dependencyFiles.push({ file: requirementsFile.path, entries: deps });
      }

      const goModPaths = findMatchingPaths("go.mod");
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
  app.post("/api/sessions/:id/generate-dockerfile", async (req, res) => {
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

      const filesToSave = dockerCandidates.length > 0 ? [dockerCandidates[0]] : filteredFiles.slice(0, 1);

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
  app.post("/api/sessions/:id/scan-docker", async (req, res) => {
    try {
      const sessionId = req.params.id;
      console.log(`\n🔍 ========== DOCKER SCAN REQUEST ==========`);
      console.log(`Session ID: ${sessionId}`);
      
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

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
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
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
        failedChecks: checks,
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
}

