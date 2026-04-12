/**
 * Kustomize Validator
 * Builds and validates Kustomize overlays, returning rendered manifests and errors.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import yaml from 'js-yaml';

// Use execFile (not exec) so arguments are never passed through a shell — prevents command injection
const execFileAsync = promisify(execFile);

export interface KustomizeBuildResult {
  success: boolean;
  manifests: string[];         // Individual YAML manifest strings
  renderedYAML: string;        // Full concatenated output
  errors: string[];
  warnings: string[];
  resourceCount: number;
  resourceTypes: string[];
}

/**
 * Check if kustomize is available in PATH
 */
async function isKustomizeAvailable(): Promise<boolean> {
  try {
    await execFileAsync('kustomize', ['version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build Kustomize overlay from a directory path
 */
export async function buildKustomize(
  kustomizationDir: string
): Promise<KustomizeBuildResult> {
  console.log(`\n🔧 ========== KUSTOMIZE BUILD ==========`);
  console.log(`   Directory: ${kustomizationDir}`);

  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate directory exists
  if (!fs.existsSync(kustomizationDir)) {
    return {
      success: false,
      manifests: [],
      renderedYAML: '',
      errors: [`Directory not found: ${kustomizationDir}`],
      warnings: [],
      resourceCount: 0,
      resourceTypes: [],
    };
  }

  // Check for kustomization.yaml / kustomization.yml
  const kustomizationFile =
    fs.existsSync(path.join(kustomizationDir, 'kustomization.yaml'))
      ? path.join(kustomizationDir, 'kustomization.yaml')
      : fs.existsSync(path.join(kustomizationDir, 'kustomization.yml'))
        ? path.join(kustomizationDir, 'kustomization.yml')
        : null;

  if (!kustomizationFile) {
    return {
      success: false,
      manifests: [],
      renderedYAML: '',
      errors: [`No kustomization.yaml found in ${kustomizationDir}`],
      warnings: [],
      resourceCount: 0,
      resourceTypes: [],
    };
  }

  const kustomizeAvailable = await isKustomizeAvailable();
  let renderedYAML = '';

  if (kustomizeAvailable) {
    try {
      // execFileAsync never spawns a shell — kustomizationDir is passed as a plain argument,
      // so path traversal / shell metacharacters cannot be injected.
      const { stdout, stderr } = await execFileAsync(
        'kustomize', ['build', kustomizationDir],
        { timeout: 30000 }
      );
      renderedYAML = stdout;
      if (stderr) warnings.push(stderr);
    } catch (err: any) {
      errors.push(`kustomize build failed: ${err.message}`);
    }
  } else {
    // Fallback: try kubectl kustomize
    try {
      const { stdout, stderr } = await execFileAsync(
        'kubectl', ['kustomize', kustomizationDir],
        { timeout: 30000 }
      );
      renderedYAML = stdout;
      if (stderr) warnings.push(stderr);
    } catch {
      // Last resort: manual YAML loading (reads kustomization.yaml resources)
      warnings.push('kustomize/kubectl not found — performing static resource listing only');
      renderedYAML = await staticKustomizeFallback(kustomizationDir, kustomizationFile);
    }
  }

  // Parse rendered YAML into individual manifests
  const manifests = renderedYAML
    .split(/^---\s*$/m)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  // Collect resource types
  const resourceTypes: string[] = [];
  for (const m of manifests) {
    try {
      const parsed = yaml.load(m) as any;
      if (parsed?.kind && !resourceTypes.includes(parsed.kind)) {
        resourceTypes.push(parsed.kind);
      }
    } catch {
      // skip unparseable
    }
  }

  const hasErrors = errors.length > 0 && renderedYAML.length === 0;
  console.log(`   ✅ ${manifests.length} resource(s) rendered, ${resourceTypes.join(', ')}`);
  console.log('==========================================\n');

  return {
    success: !hasErrors,
    manifests,
    renderedYAML,
    errors,
    warnings,
    resourceCount: manifests.length,
    resourceTypes,
  };
}

/**
 * Static fallback: reads kustomization.yaml and loads referenced resource files
 */
async function staticKustomizeFallback(
  dir: string,
  kustomizationFile: string
): Promise<string> {
  try {
    const raw = fs.readFileSync(kustomizationFile, 'utf-8');
    const kustomization = yaml.load(raw) as any;
    const resources: string[] = kustomization?.resources ?? [];
    const parts: string[] = [];
    for (const resource of resources) {
      const resourcePath = path.resolve(dir, resource);
      if (fs.existsSync(resourcePath)) {
        parts.push(fs.readFileSync(resourcePath, 'utf-8'));
      }
    }
    return parts.join('\n---\n');
  } catch {
    return '';
  }
}
