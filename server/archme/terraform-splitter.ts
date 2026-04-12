/**
 * Terraform File Splitter for ArchMe
 *
 * Post-processes generated Terraform code to split into conventional multi-file structure:
 * - providers.tf  (terraform{} and provider{} blocks)
 * - variables.tf  (variable{} blocks)
 * - outputs.tf    (output{} blocks)
 * - main.tf       (resource{} and data{} blocks)
 */

import type { GeneratedCode } from './code-generator';

interface TerraformBlock {
  type: 'terraform' | 'provider' | 'variable' | 'output' | 'resource' | 'data' | 'locals' | 'module' | 'other';
  text: string;
}

/**
 * Extract top-level HCL blocks from Terraform source
 */
function extractBlocks(source: string): TerraformBlock[] {
  const blocks: TerraformBlock[] = [];
  const lines = source.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Skip blank lines and standalone comments between blocks
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      i++;
      continue;
    }

    // Detect block type from first keyword
    const blockMatch = trimmed.match(/^(terraform|provider|variable|output|resource|data|locals|module)\s/);
    if (!blockMatch) {
      // Not a recognized block start — skip orphan lines
      i++;
      continue;
    }

    const blockType = blockMatch[1] as TerraformBlock['type'];

    // Find the opening brace
    let depth = 0;
    let blockStart = i;
    let foundBrace = false;

    // Collect preceding comment lines (attached to this block)
    let commentStart = i;
    while (commentStart > 0) {
      const prev = lines[commentStart - 1].trimStart();
      if (prev.startsWith('#') || prev.startsWith('//') || prev.startsWith('/*')) {
        commentStart--;
      } else if (prev === '') {
        // Allow one blank line before comments
        if (commentStart > 1 && (lines[commentStart - 2].trimStart().startsWith('#') || lines[commentStart - 2].trimStart().startsWith('//'))) {
          commentStart--;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    // Scan to closing brace
    let j = i;
    while (j < lines.length) {
      const chars = lines[j];
      for (let k = 0; k < chars.length; k++) {
        const ch = chars[k];
        // Skip string literals
        if (ch === '"') {
          k++;
          while (k < chars.length && chars[k] !== '"') {
            if (chars[k] === '\\') k++;
            k++;
          }
          continue;
        }
        if (ch === '{') { depth++; foundBrace = true; }
        if (ch === '}') { depth--; }
      }
      if (foundBrace && depth === 0) {
        const blockLines = lines.slice(commentStart, j + 1);
        blocks.push({ type: blockType, text: blockLines.join('\n') });
        i = j + 1;
        break;
      }
      j++;
    }

    // If we never found a matching brace, skip this line
    if (!foundBrace || depth !== 0) {
      i++;
    }
  }

  return blocks;
}

/**
 * Split Terraform files into conventional multi-file structure.
 * Only affects components with codeType === 'terraform'.
 * Returns the updated array with original .tf files replaced by split files.
 */
export function splitTerraformFiles(generatedCode: GeneratedCode[]): GeneratedCode[] {
  const nonTf = generatedCode.filter(c => c.codeType !== 'terraform');
  const tfFiles = generatedCode.filter(c => c.codeType === 'terraform');

  if (tfFiles.length === 0) return generatedCode;

  // Combine all Terraform content
  const allBlocks: TerraformBlock[] = [];
  for (const tf of tfFiles) {
    allBlocks.push(...extractBlocks(tf.content));
  }

  if (allBlocks.length === 0) return generatedCode;

  // Categorize blocks
  const providerBlocks = allBlocks.filter(b => b.type === 'terraform' || b.type === 'provider');
  const variableBlocks = allBlocks.filter(b => b.type === 'variable');
  const outputBlocks = allBlocks.filter(b => b.type === 'output');
  const mainBlocks = allBlocks.filter(b => b.type === 'resource' || b.type === 'data' || b.type === 'module' || b.type === 'locals' || b.type === 'other');

  const result: GeneratedCode[] = [...nonTf];

  // Collect component metadata from original files for the split files
  const firstTf = tfFiles[0];
  const allDeps = Array.from(new Set(tfFiles.flatMap(f => f.dependencies)));
  const allDescriptions = tfFiles.map(f => f.description).filter(Boolean);

  if (providerBlocks.length > 0) {
    result.push({
      componentName: 'providers',
      codeType: 'terraform',
      fileName: 'providers.tf',
      content: providerBlocks.map(b => b.text).join('\n\n'),
      description: 'Terraform provider and backend configuration',
      dependencies: []
    });
  }

  if (variableBlocks.length > 0) {
    result.push({
      componentName: 'variables',
      codeType: 'terraform',
      fileName: 'variables.tf',
      content: variableBlocks.map(b => b.text).join('\n\n'),
      description: 'Input variables for the infrastructure',
      dependencies: []
    });
  }

  if (mainBlocks.length > 0) {
    result.push({
      componentName: 'main',
      codeType: 'terraform',
      fileName: 'main.tf',
      content: mainBlocks.map(b => b.text).join('\n\n'),
      description: allDescriptions.join('; ') || 'Main infrastructure resources',
      dependencies: allDeps
    });
  }

  if (outputBlocks.length > 0) {
    result.push({
      componentName: 'outputs',
      codeType: 'terraform',
      fileName: 'outputs.tf',
      content: outputBlocks.map(b => b.text).join('\n\n'),
      description: 'Output values from the infrastructure',
      dependencies: []
    });
  }

  console.log(`   📂 Split ${tfFiles.length} TF file(s) → ${result.length - nonTf.length} structured files (providers.tf, variables.tf, main.tf, outputs.tf)`);
  return result;
}
