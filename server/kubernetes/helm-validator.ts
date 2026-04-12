import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, mkdtemp, rmdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);

export interface LintIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
}

export interface LintResult {
  success: boolean;
  status: 'passed' | 'failed' | 'warning';
  output: string;
  warnings: LintIssue[];
  errors: LintIssue[];
}

/**
 * Parse Helm lint output
 */
function parseHelmLintOutput(output: string, stderr: string): LintResult {
  const warnings: LintIssue[] = [];
  const errors: LintIssue[] = [];
  const combinedOutput = output + stderr;

  // Helm lint output format:
  // [INFO] Chart.yaml: icon is recommended
  // [WARNING] templates/deployment.yaml: missing required field "replicas"
  // [ERROR] templates/service.yaml: invalid service type

  const lines = combinedOutput.split('\n');
  for (const line of lines) {
    if (line.includes('[ERROR]')) {
      const match = line.match(/\[ERROR\]\s*(.+?):\s*(.+)/);
      if (match) {
        errors.push({
          severity: 'error',
          message: match[2].trim(),
          file: match[1].trim(),
        });
      }
    } else if (line.includes('[WARNING]')) {
      const match = line.match(/\[WARNING\]\s*(.+?):\s*(.+)/);
      if (match) {
        warnings.push({
          severity: 'warning',
          message: match[2].trim(),
          file: match[1].trim(),
        });
      }
    }
  }

  const hasErrors = errors.length > 0;
  const hasWarnings = warnings.length > 0;

  return {
    success: !hasErrors,
    status: hasErrors ? 'failed' : hasWarnings ? 'warning' : 'passed',
    output: combinedOutput,
    warnings,
    errors,
  };
}

/**
 * Lint a Helm chart
 */
export async function lintHelmChart(chartPath: string): Promise<LintResult> {
  try {
    console.log(`\n🔍 Running helm lint on: ${chartPath}`);
    
    const { stdout, stderr } = await execFileAsync('helm', ['lint', chartPath], {
      timeout: 30000, // 30 second timeout
    });

    const result = parseHelmLintOutput(stdout, stderr);
    console.log(`✅ Helm lint completed: ${result.status}`);
    if (result.errors.length > 0) {
      console.log(`   Errors: ${result.errors.length}`);
    }
    if (result.warnings.length > 0) {
      console.log(`   Warnings: ${result.warnings.length}`);
    }

    return result;
  } catch (error: any) {
    console.error(`❌ Helm lint failed:`, error.message);
    
    // Try to parse error output
    const stderr = error.stderr || '';
    const stdout = error.stdout || '';
    const result = parseHelmLintOutput(stdout, stderr);
    
    // If we couldn't parse anything, add the error message
    if (result.errors.length === 0 && result.warnings.length === 0) {
      result.errors.push({
        severity: 'error',
        message: error.message || 'Helm lint failed',
      });
    }

    return {
      ...result,
      success: false,
      status: 'failed',
    };
  }
}

/**
 * Extract rendered templates from Helm chart
 */
export async function renderHelmChart(chartPath: string, values?: Record<string, any>): Promise<string[]> {
  try {
    console.log(`\n📦 Rendering Helm chart: ${chartPath}`);
    
    const templateArgs = ['template', chartPath];
    if (values) {
      // Create temporary values file
      const tempDir = await mkdtemp(join(tmpdir(), 'helm-values-'));
      const valuesFile = join(tempDir, 'values.yaml');
      const yaml = await import('js-yaml');
      await writeFile(valuesFile, yaml.dump(values), 'utf-8');
      templateArgs.push('-f', valuesFile);
    }

    const { stdout } = await execFileAsync('helm', templateArgs, {
      timeout: 60000, // 60 second timeout
    });

    // Split by --- separator
    const resources = stdout
      .split(/^---\s*$/m)
      .map(r => r.trim())
      .filter(r => r.length > 0);

    console.log(`✅ Rendered ${resources.length} resource(s)`);
    return resources;
  } catch (error: any) {
    console.error(`❌ Failed to render Helm chart:`, error.message);
    throw new Error(`Failed to render Helm chart: ${error.message}`);
  }
}



