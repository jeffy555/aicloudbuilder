/**
 * Download Checkov Azure Check Definitions
 * 
 * This script downloads all Azure check definitions from Checkov's GitHub repository
 * and converts them to our remediation template format.
 * 
 * Checkov stores checks in: checkov/checkov/checks/azure/
 */

import fs from 'fs/promises';
import path from 'path';
import https from 'https';
import { createWriteStream } from 'fs';
import yaml from 'js-yaml';

const CHECKOV_REPO = 'bridgecrewio/checkov';
const CHECKOV_BRANCH = 'master'; // or 'main' depending on Checkov's default branch
const AZURE_CHECKS_PATH = 'checkov/checks/azure';
const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com';

interface GitHubFile {
  name: string;
  path: string;
  type: 'file' | 'dir';
  download_url?: string;
}

interface CheckovCheck {
  id: string;
  name: string;
  resource_types?: string[];
  severity?: string;
  categories?: string[];
  guideline?: string;
}

/**
 * Fetch directory contents from GitHub API
 */
async function fetchGitHubDirectory(repo: string, path: string, branch: string = 'master'): Promise<GitHubFile[]> {
  return new Promise((resolve, reject) => {
    const url = `${GITHUB_API_BASE}/repos/${repo}/contents/${path}?ref=${branch}`;
    
    https.get(url, {
      headers: {
        'User-Agent': 'Checkov-Downloader',
        'Accept': 'application/vnd.github.v3+json'
      }
    }, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const files = JSON.parse(data);
            resolve(Array.isArray(files) ? files : []);
          } catch (error) {
            reject(new Error(`Failed to parse GitHub API response: ${error}`));
          }
        } else {
          reject(new Error(`GitHub API error: ${res.statusCode} - ${data}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Download file from GitHub
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 200) {
        const fileStream = createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          resolve();
        });
      } else if (res.statusCode === 302 || res.statusCode === 301) {
        // Follow redirect
        downloadFile(res.headers.location!, destPath).then(resolve).catch(reject);
      } else {
        reject(new Error(`Failed to download: ${res.statusCode}`));
      }
    }).on('error', reject);
  });
}

/**
 * Extract check information from Checkov Python file
 */
function parseCheckovFile(content: string): Partial<CheckovCheck> | null {
  // Extract check ID (e.g., CKV_AZURE_1)
  const idMatch = content.match(/check_id\s*=\s*["']([^"']+)["']/);
  if (!idMatch) return null;
  
  const checkId = idMatch[1];
  
  // Extract check name
  const nameMatch = content.match(/name\s*=\s*["']([^"']+)["']/);
  const checkName = nameMatch ? nameMatch[1] : checkId;
  
  // Extract supported resources
  const resourceMatch = content.match(/supported_resources\s*=\s*\[([^\]]+)\]/);
  const resources = resourceMatch 
    ? resourceMatch[1].split(',').map(r => r.trim().replace(/["']/g, ''))
    : [];
  
  // Extract categories
  const categoriesMatch = content.match(/categories\s*=\s*\[([^\]]+)\]/);
  const categories = categoriesMatch
    ? categoriesMatch[1].split(',').map(c => c.trim().replace(/["']/g, ''))
    : [];
  
  return {
    id: checkId,
    name: checkName,
    resource_types: resources,
    categories
  };
}

/**
 * Convert Checkov check to our remediation template format
 */
function convertToRemediationTemplate(
  check: CheckovCheck,
  checkovFileContent: string
): any {
  // Extract Terraform attribute from check logic (simplified)
  // This would need more sophisticated parsing in production
  const attributeMatch = checkovFileContent.match(/self\.(\w+)/);
  const terraformAttribute = attributeMatch ? attributeMatch[1] : '';
  
  return {
    check_id: check.id,
    check_name: check.name,
    resource_types: check.resource_types || [],
    terraform_attribute: terraformAttribute,
    attribute_type: 'simple', // Default, would need better detection
    required_value: null, // Would need to extract from check logic
    description: check.name,
    remediation_snippet: `# TODO: Generate remediation snippet for ${check.id}`,
    complete_example: `# TODO: Generate complete example for ${check.id}`,
    tags: check.categories || [],
    keywords: [check.id.toLowerCase(), ...(check.categories || [])],
    confidence_factors: {
      exact_match: false,
      tested: false,
      documentation_url: `https://www.checkov.io/5.Policy%20Index/all.html?check=${check.id}`
    }
  };
}

/**
 * Main function to download all Azure checks
 */
async function downloadAzureChecks(): Promise<void> {
  console.log('🔍 Fetching Azure checks from Checkov repository...');
  console.log(`   Repository: ${CHECKOV_REPO}`);
  console.log(`   Path: ${AZURE_CHECKS_PATH}`);
  console.log(`   Branch: ${CHECKOV_BRANCH}\n`);
  
  try {
    // Fetch directory listing
    const files = await fetchGitHubDirectory(CHECKOV_REPO, AZURE_CHECKS_PATH, CHECKOV_BRANCH);
    console.log(`📁 Found ${files.length} items in Azure checks directory\n`);
    
    // Filter for Python files (Checkov checks are Python files)
    const pythonFiles = files.filter(f => f.type === 'file' && f.name.endsWith('.py'));
    console.log(`🐍 Found ${pythonFiles.length} Python check files\n`);
    
    // Create output directory
    const outputDir = path.join(process.cwd(), 'remediations', 'azure', 'downloaded');
    await fs.mkdir(outputDir, { recursive: true });
    
    let downloaded = 0;
    let converted = 0;
    let failed = 0;
    
    // Download and process each file
    for (const file of pythonFiles) {
      try {
        console.log(`📥 Downloading: ${file.name}...`);
        
        // Download the Python file
        const rawUrl = `${GITHUB_RAW_BASE}/${CHECKOV_REPO}/${CHECKOV_BRANCH}/${file.path}`;
        const tempPath = path.join(outputDir, file.name);
        await downloadFile(rawUrl, tempPath);
        
        // Read and parse the file
        const content = await fs.readFile(tempPath, 'utf-8');
        const checkInfo = parseCheckovFile(content);
        
        if (checkInfo && checkInfo.id) {
          // Convert to remediation template
          const template = convertToRemediationTemplate(checkInfo, content);
          
          // Save as YAML
          const yamlPath = path.join(
            outputDir,
            `${checkInfo.id}_${file.name.replace('.py', '')}.yaml`
          );
          await fs.writeFile(yamlPath, yaml.dump(template, { indent: 2 }));
          
          console.log(`   ✅ Converted: ${checkInfo.id} → ${path.basename(yamlPath)}`);
          converted++;
          
          // Remove temp Python file
          await fs.unlink(tempPath);
        } else {
          console.log(`   ⚠️  Could not parse check info from ${file.name}`);
          failed++;
        }
        
        downloaded++;
      } catch (error: any) {
        console.error(`   ❌ Failed to process ${file.name}: ${error.message}`);
        failed++;
      }
    }
    
    console.log(`\n📊 Summary:`);
    console.log(`   Downloaded: ${downloaded}`);
    console.log(`   Converted: ${converted}`);
    console.log(`   Failed: ${failed}`);
    console.log(`\n💾 Templates saved to: ${outputDir}`);
    console.log(`\n⚠️  Note: These templates need manual review and completion:`);
    console.log(`   - remediation_snippet needs to be filled in`);
    console.log(`   - complete_example needs to be generated`);
    console.log(`   - terraform_attribute needs verification`);
    console.log(`   - required_value needs to be determined`);
    
  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    throw error;
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  downloadAzureChecks()
    .then(() => {
      console.log('\n✅ Download complete!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Download failed:', error);
      process.exit(1);
    });
}

export { downloadAzureChecks };

