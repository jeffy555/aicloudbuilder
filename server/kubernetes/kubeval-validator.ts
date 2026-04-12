import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, mkdtemp, rmdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  file?: string;
  line?: number;
  field?: string;
}

export interface ValidationResult {
  success: boolean;
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  output: string;
}

/**
 * Parse Kubeval output
 */
function parseKubevalOutput(output: string): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Kubeval output format (JSON):
  // {"valid": false, "errors": [{"filename": "deployment.yaml", "kind": "Deployment", "name": "app", "status": "invalid", "errors": ["..."]}]}

  try {
    // Try to parse as JSON first
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      
      if (parsed.errors && Array.isArray(parsed.errors)) {
        parsed.errors.forEach((error: any) => {
          if (error.errors && Array.isArray(error.errors)) {
            error.errors.forEach((errMsg: string) => {
              errors.push({
                severity: 'error',
                message: errMsg,
                file: error.filename,
              });
            });
          }
        });
      }
    } else {
      // Parse text output
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.includes('ERROR') || line.includes('Invalid')) {
          const match = line.match(/(.+?):\s*(.+)/);
          if (match) {
            errors.push({
              severity: 'error',
              message: match[2].trim(),
              file: match[1].trim(),
            });
          }
        } else if (line.includes('WARNING')) {
          const match = line.match(/(.+?):\s*(.+)/);
          if (match) {
            warnings.push({
              severity: 'warning',
              message: match[2].trim(),
              file: match[1].trim(),
            });
          }
        }
      }
    }
  } catch (parseError) {
    // If parsing fails, check if output indicates success
    if (output.toLowerCase().includes('valid') && !output.toLowerCase().includes('invalid')) {
      // Likely valid
      return {
        success: true,
        valid: true,
        errors: [],
        warnings: [],
        output,
      };
    }
    
    // Add generic error
    errors.push({
      severity: 'error',
      message: 'Failed to parse kubeval output',
    });
  }

  return {
    success: errors.length === 0,
    valid: errors.length === 0,
    errors,
    warnings,
    output,
  };
}

/**
 * Validate Kubernetes YAML using Kubeval
 */
export async function validateKubernetesYAML(
  yamlContent: string | string[],
  k8sVersion?: string
): Promise<ValidationResult> {
  try {
    const tempDir = await mkdtemp(join(tmpdir(), 'kubeval-'));
    const yamlFiles = Array.isArray(yamlContent) ? yamlContent : [yamlContent];
    
    // Write YAML files to temp directory
    const filePaths: string[] = [];
    for (let i = 0; i < yamlFiles.length; i++) {
      const filePath = join(tempDir, `resource-${i}.yaml`);
      await writeFile(filePath, yamlFiles[i], 'utf-8');
      filePaths.push(filePath);
    }

    console.log(`\n🔍 Running kubeval on ${filePaths.length} file(s)`);

    // Try different kubeval command variations
    const isWindows = process.platform === 'win32';

    // Build base args
    const baseArgs = [...filePaths, ...(k8sVersion ? ['--kubernetes-version', k8sVersion] : [])];

    const commands: [string, string[]][] = isWindows
      ? [
          ['kubeval', baseArgs],
          ['npx', ['kubeval', ...baseArgs]],
          ['py', ['-m', 'kubeval', ...baseArgs]],
        ]
      : [
          ['kubeval', baseArgs],
          ['npx', ['kubeval', ...baseArgs]],
          ['python3', ['-m', 'kubeval', ...baseArgs]],
        ];

    let stdout = '';
    let stderr = '';
    let commandWorked = false;

    for (const [cmd, args] of commands) {
      try {
        console.log(`   Trying: ${cmd} ${args.join(' ').substring(0, 80)}...`);
        const result = await execFileAsync(cmd, args, {
          timeout: 30000, // 30 second timeout
          cwd: tempDir,
        });
        stdout = result.stdout || '';
        stderr = result.stderr || '';
        commandWorked = true;
        console.log(`   ✅ Command succeeded`);
        break;
      } catch (error: any) {
        // Try next command
        if (error.stdout || error.stderr) {
          stdout = error.stdout || '';
          stderr = error.stderr || '';
          commandWorked = true;
          console.log(`   ✅ Command returned output (may have errors)`);
          break;
        }
        continue;
      }
    }

    if (!commandWorked) {
      throw new Error('kubeval command not found. Please install kubeval: npm install -g kubeval');
    }

    const result = parseKubevalOutput(stdout + stderr);
    
    // Cleanup
    try {
      for (const filePath of filePaths) {
        await unlink(filePath);
      }
      await rmdir(tempDir);
    } catch (cleanupError) {
      console.warn(`⚠️  Failed to cleanup temp directory: ${tempDir}`);
    }

    console.log(`✅ Kubeval completed: ${result.valid ? 'valid' : 'invalid'}`);
    if (result.errors.length > 0) {
      console.log(`   Errors: ${result.errors.length}`);
    }

    return result;
  } catch (error: any) {
    console.error(`❌ Kubeval validation failed:`, error.message);
    
    // Try to parse error output
    const stderr = error.stderr || '';
    const stdout = error.stdout || '';
    const result = parseKubevalOutput(stdout + stderr);
    
    // If we couldn't parse anything, add the error message
    if (result.errors.length === 0) {
      result.errors.push({
        severity: 'error',
        message: error.message || 'Kubeval validation failed',
      });
    }

    return {
      ...result,
      success: false,
      valid: false,
    };
  }
}

