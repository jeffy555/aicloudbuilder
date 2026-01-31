/**
 * Shared utility functions for route handlers
 */

/**
 * Helper function to repair JSON (same as in openai-service.ts)
 */
export function repairJson(jsonText: string): string {
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
 * Helper function to find matching brace for Terraform blocks
 */
export function findMatchingBrace(content: string, startIndex: number): number {
  let depth = 1;
  let i = startIndex;
  while (i < content.length && depth > 0) {
    if (content[i] === '{') depth++;
    if (content[i] === '}') depth--;
    i++;
  }
  return i;
}

/**
 * Helper function to validate that a fix actually addresses Checkov issues
 */
export function validateFix(originalContent: string, fixedContent: string, checks: any[]): { isValid: boolean; warnings: string[] } {
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
export function extractBaseResourceName(resourceName: string): string {
  if (!resourceName) return resourceName;
  // Remove [index] suffix for count/for_each resources
  return resourceName.replace(/\[.*?\]$/, '');
}

/**
 * Extract fix snippet from fixed content
 * Simplified version - in production, use AST parsing for accuracy
 */
export function extractFixSnippet(
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
export async function verifyChecksWithCheckov(
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

