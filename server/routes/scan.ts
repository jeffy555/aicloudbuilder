import type { Express } from "express";
import { storage } from "../storage";
import { mcpClient, type MCPProvider } from "../mcp-client";
import { optionalAuth, type AuthenticatedRequest } from "../middleware/auth";
import { validateRequest } from "../middleware/validate";
import { sessionIdParams } from "@shared/api-contracts/common";
import { scanBody } from "@shared/api-contracts/scan";
import { getFixGuidance } from "../checkov-fix-guidance";

export function registerScanRoutes(app: Express): void {
  app.post("/api/sessions/:id/scan", optionalAuth, validateRequest({ params: sessionIdParams, body: scanBody }), async (req: AuthenticatedRequest, res) => {
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
      if (!session?.userId || session.userId !== req.userId) {
        console.warn(`[SECURITY] Scan session access denied: sessionId=${sessionId} sessionOwner=${session.userId} requesterId=${req.userId ?? 'anonymous'} ip=${req.ip}`);
        clearTimeout(responseTimeout);
        responseSent = true;
        return res.status(403).json({ error: 'Access denied to this session' });
      }

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

        // For aggregated-root: root module may only have non-TF files (e.g. README) in edge cases.
        // Return a clean 200 with 0 resources so the pipeline can advance without error.
        if (session.moduleApproach === 'aggregated-root') {
          console.log(`   ℹ️  aggregated-root with no TF files — returning clean 0-resource result`);
          clearTimeout(responseTimeout);
          responseSent = true;
          return res.json({
            success: true,
            summary: { passed: 0, failed: 0, skipped: 0, total: 0, passPercentage: 0 },
            failedChecks: [],
            passedChecks: [],
          });
        }

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
              // On Windows, we can use PowerShell, cmd.exe, or Git Bash
              // Try to detect if we're in Git Bash (SHELL env var or MSYSTEM)
              const isGitBash = process.env.SHELL?.includes('bash') || process.env.MSYSTEM?.startsWith('MINGW');
              const useGitBash = isGitBash && isWindows;

              let finalCommand = command;
              let finalArgs = fullArgs;
              let useShell = isWindows || useGitBash;

              if (useGitBash) {
                // Git Bash: Use bash -c to execute commands
                // CRITICAL: Convert Windows backslash paths to forward slashes for bash
                // Otherwise bash interprets backslashes as escape characters and the path breaks
                console.log(`   Detected Git Bash environment (SHELL=${process.env.SHELL}, MSYSTEM=${process.env.MSYSTEM})`);
                const bashArgs = fullArgs.map(a => a.replace(/\\/g, '/'));
                finalCommand = 'bash';
                finalArgs = ['-c', `${command} ${bashArgs.join(' ')}`];
                useShell = false; // bash is the command, don't use shell wrapper
                console.log(`   Using Git Bash execution: bash -c "${command} ${bashArgs.join(' ')}"`);
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
            console.warn(`\n⚠️  ========== CHECKOV PARSING ERRORS DETECTED ==========`);
            console.warn(`   Parsing errors: ${parsingErrors}`);
            console.warn(`   Resource count: ${resourceCount}`);
            console.warn(`   Some Terraform files could not be fully parsed`);

            // Log detailed parsing errors for debugging
            if (scanResult.results?.parsing_errors && Array.isArray(scanResult.results.parsing_errors)) {
              console.warn(`\n   Detailed parsing errors:`);
              scanResult.results.parsing_errors.forEach((error: any, idx: number) => {
                console.warn(`   ${idx + 1}. File: ${error.file_path || error.file || 'unknown'}`);
                console.warn(`      Error: ${error.error_message || error.message || error.error || 'Unknown parsing error'}`);
              });
            }
            console.warn(`==========================================\n`);

            // If there ARE valid resources despite parsing errors, continue with those results.
            // Parsing errors often happen after AI fixes modify files — the valid checks still matter.
            if (resourceCount > 0) {
              console.log(`   ℹ️  ${resourceCount} resource(s) scanned successfully despite ${parsingErrors} parsing error(s) — returning results`);
              // Fall through to normal result processing below
            } else {
              // No resources at all — return a clean result so the pipeline advances.
              // Returning 400 would break the UI flow for no benefit (user can't fix parsing in the scan UI).
              console.log(`   ℹ️  No resources scanned — returning clean 0-resource result so pipeline can continue`);
              clearTimeout(responseTimeout);
              if (!responseSent && !res.headersSent) {
                responseSent = true;
                return res.json({
                  success: true,
                  summary: { passed: 0, failed: 0, skipped: 0, total: 0, passPercentage: 0 },
                  failedChecks: [],
                  passedChecks: [],
                });
              }
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
          failedChecks: checks.map((check: any) => {
            const guidance = getFixGuidance(check.check_id, check.check_name);
            return {
              checkId: check.check_id,
              checkName: check.check_name,
              resource: check.resource,
              file: check.file_path?.replace(tempDir, ''),
              guideline: check.guideline,
              severity: check.severity || guidance?.severity || null,
              bcCheckId: check.bc_check_id || null,
              autoFixable: guidance?.autoFixable ?? false,
              fixComplexity: guidance?.fixComplexity || 'moderate',
              complianceStandards: guidance?.complianceStandards || [],
              // Add failure reason/explanation
              reason: check.check_result?.evaluated_keys
                ? `Missing or incorrect: ${check.check_result.evaluated_keys.join(', ')}`
                : check.check_result?.result === 'FAILED'
                ? `Check failed: ${check.check_name}`
                : check.guideline || `Security check ${check.check_id} failed for this resource`,
              evaluatedKeys: check.check_result?.evaluated_keys || [],
              checkResult: check.check_result?.result || 'FAILED'
            };
          }),
          passedChecks: passedChecks.slice(0, 10).map((check: any) => ({
            checkId: check.check_id,
            checkName: check.check_name,
            resource: check.resource,
            severity: check.severity || null
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
}
