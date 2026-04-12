/**
 * Code Generator for ArchMe Components
 * 
 * Generates infrastructure code (Terraform, ARM, Helm, YAML) for each component
 */

import { aiChatCompletion } from '../utils/ai-client.js';
import type { ExtractedComponent } from './component-extractor';
import { sanitizeField, sanitizeContent } from '../utils/sanitize-prompt.js';

export interface GeneratedCode {
  componentName: string;
  codeType: 'terraform' | 'arm' | 'helm' | 'yaml' | 'kubernetes';
  fileName: string;
  content: string;
  description: string;
  dependencies: string[];
}

interface ResourceBlock {
  header: string;
  type: string;
  localName: string;
  body: string;
  fullText: string;
  startIndex: number;
  endIndex: number;
}

function parseResourceBlocks(terraform: string): ResourceBlock[] {
  const blocks: ResourceBlock[] = [];
  const resourceHeaderRegex = /^resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/gm;
  let match: RegExpExecArray | null;

  while ((match = resourceHeaderRegex.exec(terraform)) !== null) {
    const [header, type, localName] = match;
    const startIndex = match.index;
    const bodyStart = startIndex + header.length;
    let depth = 1;
    let cursor = bodyStart;

    while (cursor < terraform.length && depth > 0) {
      const char = terraform[cursor];
      // Skip string literals (braces inside quotes don't count)
      if (char === '"') {
        cursor += 1;
        while (cursor < terraform.length && terraform[cursor] !== '"') {
          if (terraform[cursor] === '\\') cursor += 1; // skip escaped chars
          cursor += 1;
        }
        cursor += 1;
        continue;
      }
      // Skip single-line comments (# or //)
      if (char === '#' || (char === '/' && terraform[cursor + 1] === '/')) {
        while (cursor < terraform.length && terraform[cursor] !== '\n') cursor += 1;
        cursor += 1;
        continue;
      }
      // Skip multi-line comments (/* ... */)
      if (char === '/' && terraform[cursor + 1] === '*') {
        cursor += 2;
        while (cursor < terraform.length - 1 && !(terraform[cursor] === '*' && terraform[cursor + 1] === '/')) cursor += 1;
        cursor += 2;
        continue;
      }
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
      cursor += 1;
    }

    const endIndex = cursor;
    const fullText = terraform.slice(startIndex, endIndex);
    const body = terraform.slice(bodyStart, endIndex - 1).trim();

    blocks.push({
      header,
      type,
      localName,
      body,
      fullText,
      startIndex,
      endIndex,
    });

    resourceHeaderRegex.lastIndex = endIndex;
  }

  return blocks;
}

function extractSimpleAttribute(body: string, key: string): string | null {
  const attrRegex = new RegExp(`^\\s*${key}\\s*=\\s*([^\\n#]+)`, "m");
  const match = body.match(attrRegex);
  return match ? match[1].trim() : null;
}

function normalizeTerraformText(input: string): string {
  return input
    .replace(/\s+/g, " ")
    .replace(/"/g, "")
    .trim()
    .toLowerCase();
}

function dedupeTerraformResources(terraform: string): string {
  const blocks = parseResourceBlocks(terraform);
  if (blocks.length <= 1) return terraform;

  const duplicateKeys = new Set<string>();
  const seenKeys = new Set<string>();
  const rangesToRemove: Array<{ start: number; end: number }> = [];

  for (const block of blocks) {
    const hasCount = /\bcount\s*=/.test(block.body);
    const hasForEach = /\bfor_each\s*=/.test(block.body);
    if (hasCount || hasForEach) {
      continue;
    }

    const configuredName = extractSimpleAttribute(block.body, "name");
    const semanticName = configuredName
      ? normalizeTerraformText(configuredName)
      : normalizeTerraformText(block.localName);
    const bodyFingerprint = normalizeTerraformText(
      block.body
        .replace(/^\s*name\s*=.*$/gm, "")
        .replace(/^\s*resource_group_name\s*=.*$/gm, "")
    );
    const dedupeKey = `${block.type}|${semanticName}|${bodyFingerprint}`;

    if (seenKeys.has(dedupeKey)) {
      duplicateKeys.add(`${block.type}:${semanticName}`);
      rangesToRemove.push({ start: block.startIndex, end: block.endIndex });
      continue;
    }

    seenKeys.add(dedupeKey);
  }

  if (duplicateKeys.size > 0) {
    console.warn(
      `   ⚠️ Removed duplicate Terraform resources: ${Array.from(duplicateKeys).join(", ")}`
    );
  }

  if (rangesToRemove.length === 0) return terraform;

  let output = "";
  let cursor = 0;
  for (const range of rangesToRemove.sort((a, b) => a.start - b.start)) {
    output += terraform.slice(cursor, range.start);
    cursor = range.end;
  }
  output += terraform.slice(cursor);
  return output
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function shouldAllowDuplicateResources(component: ExtractedComponent): boolean {
  const context = `${component.name} ${component.type} ${component.description}`.toLowerCase();
  const explicitDuplicationPatterns = [
    /\bmultiple\b/,
    /\bduplicate\b/,
    /\b2x\b|\b3x\b|\b4x\b/,
    /\btwo\b|\bthree\b|\bfour\b/,
    /\bprod\b.*\bdev\b|\bdev\b.*\bprod\b/,
    /\bstaging\b.*\bprod\b|\bprod\b.*\bstaging\b/,
    /\bactive[-\s]?active\b/,
    /\bmulti[-\s]?region\b/,
    /\bper[-\s]?region\b/,
    /\bsecondary\b|\bprimary\b/,
  ];
  return explicitDuplicationPatterns.some((pattern) => pattern.test(context));
}

/**
 * Generate infrastructure code for a component
 */
export async function generateComponentCode(
  component: ExtractedComponent,
  allComponents: ExtractedComponent[],
  repositoryType: 'github' | 'azure'
): Promise<GeneratedCode> {
  console.log(`\n💻 Generating ${component.codeType} code for: ${component.name}`);
  
  // Build context about dependencies
  const dependencyInfo = component.dependencies
    .map(depName => {
      const dep = allComponents.find(c => c.name === depName);
      return dep ? `${dep.name} (${dep.provider}, ${dep.type})` : depName;
    })
    .join(', ');
  
  const systemPrompt = `You are an expert infrastructure engineer. Generate production-ready infrastructure code based on the component specifications.

IMPORTANT GUIDELINES:
1. Generate ONLY the code, no explanations or markdown formatting
2. Use best practices for the specified code type
3. Include all necessary configuration
4. Reference dependencies correctly
5. Use appropriate naming conventions
6. Include comments for clarity
7. For Terraform: Include resource blocks, variables if needed, and outputs
8. Never duplicate logical resources in Terraform unless the user explicitly requests multiple instances/environments
9. Do not emit "example" and "main" versions of the same infrastructure in one file
10. If a dependency is already represented, reference it instead of re-declaring it
11. For ARM templates: Include complete JSON template structure
12. For Helm: Include values.yaml and Chart.yaml
13. For YAML/Kubernetes: Include complete manifests
14. For Kubernetes: Include all necessary resources (Deployment, Service, ConfigMap, etc.)`;

  const userPrompt = `Generate ${component.codeType} code for:

COMPONENT: ${sanitizeField(component.name)}
TYPE: ${sanitizeField(component.type)}
PROVIDER: ${sanitizeField(component.provider)}
CATEGORY: ${sanitizeField(component.category)}
DESCRIPTION: ${sanitizeContent(component.description)}
${component.metadata?.serviceType ? `SERVICE TYPE: ${sanitizeField(component.metadata.serviceType)}` : ''}

DEPENDENCIES: ${dependencyInfo ? sanitizeContent(dependencyInfo) : 'None'}

REPOSITORY TYPE: ${repositoryType}

Generate complete, production-ready ${component.codeType} code for this component.`;

  try {
    const completion = await aiChatCompletion({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 4000,
    });

    let code = completion.choices[0]?.message?.content?.trim() || '';
    
    // Remove markdown code blocks if present
    code = code
      .replace(/^```(?:terraform|hcl|json|yaml|yml)?\n?/i, '')
      .replace(/^```\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim();

    // Validate generated code quality
    if (code.length < 20) {
      console.warn(`⚠️ AI returned suspiciously short code for ${component.name}: "${code.substring(0, 50)}"`);
    }
    const codeValidators: Record<string, RegExp> = {
      terraform: /resource\s+"|variable\s+"|provider\s+"|module\s+"/,
      yaml: /apiVersion:|kind:|metadata:/,
      helm: /^\s*(replicaCount|image|service|ingress)/m,
      arm: /\$schema.*deploymentTemplate/i,
      kubernetes: /apiVersion:|kind:|metadata:/,
    };
    const expectedPattern = codeValidators[component.codeType];
    if (expectedPattern && !expectedPattern.test(code)) {
      console.warn(`⚠️ Generated code for ${component.name} may not be valid ${component.codeType} — expected patterns not found`);
    }

    if (component.codeType === "terraform" && !shouldAllowDuplicateResources(component)) {
      code = dedupeTerraformResources(code);
    }

    // Determine file name
    const fileName = getFileName(component, component.codeType);

    console.log(`   ✅ Generated ${component.codeType} code (${code.length} chars)`);

    return {
      componentName: component.name,
      codeType: component.codeType,
      fileName,
      content: code,
      description: component.description,
      dependencies: component.dependencies
    };
  } catch (error: any) {
    console.error(`   ❌ Failed to generate code: ${error.message}`);
    throw new Error(`Failed to generate code for ${component.name}: ${error.message}`);
  }
}

/**
 * Get appropriate file name for component
 */
function getFileName(component: ExtractedComponent, codeType: string): string {
  const sanitizedName = component.name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 30);

  switch (codeType) {
    case 'terraform':
      return `${sanitizedName}.tf`;
    case 'arm':
      return `${sanitizedName}.json`;
    case 'helm':
      return `charts/${sanitizedName}/values.yaml`;
    case 'yaml':
    case 'kubernetes':
      return `${sanitizedName}.yaml`;
    default:
      return `${sanitizedName}.tf`;
  }
}

/**
 * Generate code for all components
 */
export async function generateAllComponentCode(
  components: ExtractedComponent[],
  repositoryType: 'github' | 'azure'
): Promise<GeneratedCode[]> {
  console.log(`\n🚀 ========== GENERATING CODE FOR ALL COMPONENTS ==========`);
  console.log(`📦 Components: ${components.length}`);
  console.log(`📁 Repository: ${repositoryType}`);

  const CONCURRENCY = 3;
  const results: GeneratedCode[] = [];

  // Process in batches of CONCURRENCY for parallel generation
  for (let i = 0; i < components.length; i += CONCURRENCY) {
    const batch = components.slice(i, i + CONCURRENCY);
    console.log(`   🔄 Batch ${Math.floor(i / CONCURRENCY) + 1}: generating ${batch.map(c => c.name).join(', ')}`);

    const batchResults = await Promise.allSettled(
      batch.map(component => generateComponentCode(component, components, repositoryType))
    );

    for (let j = 0; j < batchResults.length; j++) {
      const result = batchResults[j];
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        console.error(`   ❌ Failed for ${batch[j].name}: ${result.reason?.message || result.reason}`);
      }
    }
  }

  console.log(`\n✅ Generated code for ${results.length}/${components.length} components`);
  return results;
}

