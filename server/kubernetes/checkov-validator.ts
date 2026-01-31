import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, mkdtemp, rmdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const execAsync = promisify(exec);

export interface CheckovCheck {
  checkId: string;
  checkName: string;
  file: string;
  resource: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  message: string;
  guideline?: string;
}

export interface CheckovResult {
  success: boolean;
  passed: number;
  failed: number;
  skipped: number;
  checks: CheckovCheck[];
  summary: string;
}

/**
 * Parse Checkov JSON output for Kubernetes
 */
function parseCheckovOutput(output: string): CheckovResult {
  const checks: CheckovCheck[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  try {
    // Try to parse JSON output
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      
      // Log the full parsed structure for debugging
      console.log(`\n📊 Checkov JSON structure:`, JSON.stringify(parsed, null, 2).substring(0, 2000));
      console.log(`\n📋 Failed checks count: ${parsed.results?.failed_checks?.length || 0}`);
      console.log(`\n📊 Summary object:`, JSON.stringify(parsed.summary, null, 2));
      
      // IMPORTANT: With --compact flag, Checkov may not include passed_checks array
      // But the summary object contains accurate counts
      const summary = parsed.summary || {};
      const results = parsed.results || {};
      
      // Use summary counts as primary source (like Terraform scan)
      // Summary is authoritative even when passed_checks array is empty
      if (summary.passed != null) {
        passed = Number(summary.passed) || 0;
        console.log(`   ✅ Using summary.passed: ${passed}`);
      }
      if (summary.failed != null) {
        failed = Number(summary.failed) || 0;
        console.log(`   ✅ Using summary.failed: ${failed}`);
      }
      if (summary.skipped != null) {
        skipped = Number(summary.skipped) || 0;
        console.log(`   ✅ Using summary.skipped: ${skipped}`);
      }
      
      if (parsed.results && parsed.results.failed_checks) {
        parsed.results.failed_checks.forEach((check: any) => {
          // Log the raw check structure for debugging
          console.log(`\n📋 Raw Checkov check structure:`, JSON.stringify(check, null, 2));
          
          // Extract detailed failure reason from various possible fields
          let failureReason = '';
          
          // Build a descriptive reason from check name and context
          const checkName = check.check_name || check.check_id || 'Security check';
          
          // Try multiple fields where Checkov might store the failure reason
          // Priority: detailed messages > evaluated keys > check name description
          if (check.check_result?.failure_reason) {
            failureReason = String(check.check_result.failure_reason);
          } else if (check.check_result?.error_message) {
            failureReason = String(check.check_result.error_message);
          } else if (check.message) {
            failureReason = String(check.message);
          } else if (check.check_result?.evaluated_keys && Array.isArray(check.check_result.evaluated_keys) && check.check_result.evaluated_keys.length > 0) {
            // Build reason from evaluated keys - these are the missing/incorrect attributes
            const missingAttrs = check.check_result.evaluated_keys
              .filter((key: string) => key && typeof key === 'string')
              .map((key: string) => key.split('.').pop() || key); // Get last part of path
            
            if (missingAttrs.length > 0) {
              failureReason = `${checkName}. Missing or incorrect: ${missingAttrs.join(', ')}`;
            } else {
              failureReason = `${checkName}. Required attributes are missing or incorrectly configured.`;
            }
          } else if (check.check_result?.result && String(check.check_result.result) !== 'FAILED') {
            // Only use result if it's not just "FAILED"
            failureReason = String(check.check_result.result);
          } else {
            // Build a descriptive reason from the check name
            // The check name itself is usually descriptive (e.g., "Containers should not run with allowPrivilegeEscalation")
            failureReason = `${checkName}. This security requirement is not met in the current configuration.`;
            
            // Add context if we have evaluated keys but they weren't used above
            if (check.check_result?.evaluated_keys && Array.isArray(check.check_result.evaluated_keys) && check.check_result.evaluated_keys.length > 0) {
              const keys = check.check_result.evaluated_keys
                .filter((key: string) => key && typeof key === 'string')
                .map((key: string) => key.split('.').pop() || key)
                .join(', ');
              if (keys) {
                failureReason += ` Checked attributes: ${keys}`;
              }
            }
          }
          
          // Ensure we always have a meaningful reason
          if (!failureReason || failureReason.trim() === '' || failureReason.trim() === 'FAILED') {
            failureReason = `${checkName}. This security requirement is not met in the current configuration.`;
          }
          
          console.log(`   ✅ Extracted failure reason: ${failureReason.substring(0, 100)}...`);
          
          checks.push({
            checkId: check.check_id || '',
            checkName: check.check_name || '',
            file: check.file_path || check.file_abs_path || '',
            resource: check.resource || '',
            severity: (check.severity || 'MEDIUM').toUpperCase() as any,
            message: failureReason,
            guideline: check.guideline || check.check_result?.guideline || '',
          });
          // Don't increment failed here - we use summary.failed (set above) as authoritative
        });
        
        // If summary.failed was not available, count from array
        if (failed === 0) {
          failed = checks.length;
          console.log(`   ⚠️  Using failed_checks array length: ${failed} (summary.failed was not available)`);
        }
      }

      // Only use passed_checks array if summary.passed was not available
      // (fallback for older Checkov versions or non-compact output)
      if (passed === 0 && parsed.results && parsed.results.passed_checks) {
        passed = parsed.results.passed_checks.length;
        console.log(`   ⚠️  Using passed_checks array length: ${passed} (summary.passed was not available)`);
      }

      // Only use skipped_checks array if summary.skipped was not available
      if (skipped === 0 && parsed.results && parsed.results.skipped_checks) {
        skipped = parsed.results.skipped_checks.length;
        console.log(`   ⚠️  Using skipped_checks array length: ${skipped} (summary.skipped was not available)`);
      }
      
      // Final validation: ensure counts match
      const calculatedTotal = passed + failed + skipped;
      console.log(`\n📊 Final counts: passed=${passed}, failed=${failed}, skipped=${skipped}, total=${calculatedTotal}`);
    } else {
      // Parse text output (fallback)
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.includes('PASSED:')) {
          const match = line.match(/PASSED:\s*(\d+)/);
          if (match) passed = parseInt(match[1], 10);
        } else if (line.includes('FAILED:')) {
          const match = line.match(/FAILED:\s*(\d+)/);
          if (match) failed = parseInt(match[1], 10);
        } else if (line.includes('SKIPPED:')) {
          const match = line.match(/SKIPPED:\s*(\d+)/);
          if (match) skipped = parseInt(match[1], 10);
        }
      }
    }
  } catch (parseError) {
    console.warn(`⚠️  Failed to parse Checkov output:`, parseError);
  }

  const summary = `Passed: ${passed}, Failed: ${failed}, Skipped: ${skipped}`;

  return {
    success: failed === 0,
    passed,
    failed,
    skipped,
    checks,
    summary,
  };
}

/**
 * Run Checkov on Kubernetes YAML files
 */
export async function runCheckovKubernetes(
  yamlFiles: Array<{ path: string; content: string }>
): Promise<CheckovResult> {
  try {
    const tempDir = await mkdtemp(join(tmpdir(), 'checkov-k8s-'));
    
    // Write YAML files to temp directory
    const filePaths: string[] = [];
    for (const file of yamlFiles) {
      const filePath = join(tempDir, file.path.split('/').pop() || 'resource.yaml');
      await writeFile(filePath, file.content, 'utf-8');
      filePaths.push(filePath);
    }

    console.log(`\n🔍 Running Checkov on ${filePaths.length} Kubernetes file(s)`);

    const isWindows = process.platform === 'win32';
    const checkovArgs = ['-d', tempDir, '--framework', 'kubernetes', '--output', 'json', '--compact', '--quiet'];
    
    // Try different command variations
    const commands: [string, string[]][] = isWindows
      ? [
          ['checkov', checkovArgs],
          ['py', ['-m', 'uv', 'run', 'checkov', ...checkovArgs]],
          ['py', ['-m', 'checkov', ...checkovArgs]],
        ]
      : [
          ['checkov', checkovArgs],
          ['python3', ['-m', 'uv', 'run', 'checkov', ...checkovArgs]],
          ['python3', ['-m', 'checkov', ...checkovArgs]],
        ];

    let checkovOutput = '';
    let commandWorked = false;

    for (const [cmd, args] of commands) {
      try {
        const { stdout, stderr } = await execAsync(`${cmd} ${args.join(' ')}`, {
          timeout: 120000, // 2 minute timeout
          cwd: tempDir,
        });
        checkovOutput = stdout || stderr;
        commandWorked = true;
        break;
      } catch (error: any) {
        // Try next command
        if (error.stdout || error.stderr) {
          checkovOutput = error.stdout || error.stderr;
          commandWorked = true;
          break;
        }
        continue;
      }
    }

    // Cleanup
    try {
      for (const filePath of filePaths) {
        await unlink(filePath);
      }
      await rmdir(tempDir);
    } catch (cleanupError) {
      console.warn(`⚠️  Failed to cleanup temp directory: ${tempDir}`);
    }

    if (!commandWorked) {
      throw new Error('All Checkov commands failed');
    }

    const result = parseCheckovOutput(checkovOutput);
    console.log(`✅ Checkov completed: ${result.summary}`);

    return result;
  } catch (error: any) {
    console.error(`❌ Checkov validation failed:`, error.message);
    
    return {
      success: false,
      passed: 0,
      failed: 0,
      skipped: 0,
      checks: [],
      summary: 'Checkov validation failed',
    };
  }
}

