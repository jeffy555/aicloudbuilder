import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';

export interface RemediationTemplate {
  check_id: string;
  check_name: string;
  resource_types: string[];
  terraform_attribute: string;
  attribute_type: 'simple' | 'block' | 'nested_block';
  required_value: any;
  description: string;
  remediation_snippet: string;
  complete_example: string;
  tags: string[];
  keywords: string[];
  confidence_factors: {
    exact_match: boolean;
    tested: boolean;
    documentation_url?: string;
  };
}

/**
 * Recursively find all YAML files in a directory
 */
async function findYamlFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await findYamlFiles(fullPath);
        files.push(...subFiles);
      } else if (entry.isFile() && entry.name.endsWith('.yaml')) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    // Directory doesn't exist or can't be read
  }

  return files;
}

/**
 * Load all remediation templates from the remediations directory
 */
export async function loadTemplatesFromDirectory(
  baseDir: string = 'remediations'
): Promise<RemediationTemplate[]> {
  const templates: RemediationTemplate[] = [];
  const basePath = path.join(process.cwd(), baseDir);

  try {
    // Check if directory exists
    await fs.access(basePath);
  } catch {
    console.warn(`⚠️  Remediations directory not found: ${basePath}`);
    return templates;
  }

  // Recursively find all YAML files
  const yamlFiles = await findYamlFiles(basePath);
  console.log(`📁 Found ${yamlFiles.length} remediation template file(s)`);

  for (const filePath of yamlFiles) {
    try {
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const template = yaml.load(fileContent) as RemediationTemplate;

      // Validate required fields
      if (!template.check_id || !template.remediation_snippet) {
        console.warn(`⚠️  Skipping invalid template: ${filePath}`);
        continue;
      }

      templates.push(template);
      console.log(`   ✅ Loaded: ${template.check_id} (${path.basename(filePath)})`);
    } catch (error: any) {
      console.error(`❌ Failed to load template ${filePath}:`, error.message);
    }
  }

  return templates;
}

/**
 * Load a specific template by check ID
 */
export async function loadTemplateByCheckId(
  checkId: string,
  baseDir: string = 'remediations'
): Promise<RemediationTemplate | null> {
  const templates = await loadTemplatesFromDirectory(baseDir);
  return templates.find(t => t.check_id === checkId) || null;
}

/**
 * Get all template check IDs
 */
export async function getAllTemplateCheckIds(
  baseDir: string = 'remediations'
): Promise<string[]> {
  const templates = await loadTemplatesFromDirectory(baseDir);
  return templates.map(t => t.check_id);
}

