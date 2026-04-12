import OpenAI from 'openai';
import { buildMigrateOpsAzureResourcePayloadString } from './migrate-resource-payload.js';
import { buildSchemaGuidanceForResources } from './migrate-schema-guidance.js';
import { ensureContainerAppContainerCpuMemory, fixImportBlocksQuotedToAddresses } from './migrate-hcl-fixes.js';
import { aiChatCompletion } from './utils/ai-client.js';
import type { TerraformCliValidationResult } from './terraform-cli-validate.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/** MigrateOps: use a capable model by default; override with MIGRATEOPS_MODEL / MIGRATEOPS_REFINE_MODEL */
const MIGRATEOPS_MODEL = process.env.MIGRATEOPS_MODEL || 'gpt-4o';
const MIGRATEOPS_REFINE_MODEL = process.env.MIGRATEOPS_REFINE_MODEL || MIGRATEOPS_MODEL;
/** Refine pass is OFF by default — the schema-aware repair pass in migrate.ts is more capable.
 *  Set MIGRATEOPS_REFINE=true to enable as an extra AI pass (adds latency + cost). */
const MIGRATEOPS_REFINE_ENABLED =
  process.env.MIGRATEOPS_REFINE === 'true' || process.env.MIGRATEOPS_REFINE === '1';
const MIGRATEOPS_MAX_OUTPUT_TOKENS = Math.min(
  parseInt(process.env.MIGRATEOPS_MAX_OUTPUT_TOKENS || '16384', 10),
  32768
);
const MIGRATEOPS_AI_TIMEOUT_MS = parseInt(process.env.MIGRATEOPS_AI_TIMEOUT_MS || '240000', 10);

/** Terraform module workflow: AI repair after failed terraform validate (generate + optional manual endpoint) */
const TERRAFORM_MODULE_CLI_REPAIR_MODEL =
  process.env.TERRAFORM_MODULE_CLI_REPAIR_MODEL || 'gpt-4o-mini';
const TERRAFORM_MODULE_CLI_REPAIR_MAX_TOKENS = Math.min(
  parseInt(process.env.TERRAFORM_MODULE_CLI_REPAIR_MAX_TOKENS || '16384', 10),
  32768
);
const TERRAFORM_MODULE_CLI_REPAIR_TIMEOUT_MS = parseInt(
  process.env.TERRAFORM_MODULE_CLI_REPAIR_TIMEOUT_MS || '120000',
  10
);

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Attempts to repair common JSON issues in AI responses
 */
function repairJson(jsonText: string): string {
  let repaired = jsonText.trim();
  
  // Remove trailing commas before closing brackets/braces (more robust)
  // This handles cases like: [item1, item2, ] or {key: value, }
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');
  
  // Also handle trailing commas in nested structures
  repaired = repaired.replace(/,(\s*\n\s*[}\]])/g, '$1');
  
  // Fix unclosed strings in object values
  // Match patterns like: "key": "unclosed string
  repaired = repaired.replace(/"([^"]*)"\s*:\s*"([^"]*?)(\s*[,\n\]\}])/g, (match, key, value, end) => {
    // If value doesn't have a closing quote and doesn't contain escaped quotes, add one
    if (!value.includes('\\"') && !value.endsWith('"')) {
      return `"${key}": "${value}"${end}`;
    }
    return match;
  });
  
  // Remove comments (single-line and multi-line)
  repaired = repaired.replace(/\/\/.*$/gm, ''); // Single-line comments
  repaired = repaired.replace(/\/\*[\s\S]*?\*\//g, ''); // Multi-line comments
  
  // Fix missing quotes around object keys (but not if already quoted)
  repaired = repaired.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, (match, prefix, key) => {
    // Only add quotes if the key isn't already quoted
    if (!match.includes('"')) {
      return `${prefix}"${key}":`;
    }
    return match;
  });
  
  // Fix escaped quotes in strings (ensure proper escaping)
  // Note: We don't need to modify escaped quotes as they're already correct
  // This regex is just for reference - we'll leave escaped quotes as-is
  
  // Remove any control characters except newlines and tabs
  repaired = repaired.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
  
  // Fix common issues with array elements
  // Remove trailing commas in arrays more aggressively
  let lastRepaired = '';
  while (repaired !== lastRepaired) {
    lastRepaired = repaired;
    repaired = repaired.replace(/,(\s*[}\]])/g, '$1');
  }
  
  return repaired;
}

interface TerraformResourceBlock {
  type: string;
  localName: string;
  body: string;
  startIndex: number;
  endIndex: number;
}

function parseTerraformResourceBlocks(terraform: string): TerraformResourceBlock[] {
  const blocks: TerraformResourceBlock[] = [];
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
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
      cursor += 1;
    }

    const endIndex = cursor;
    const body = terraform.slice(bodyStart, endIndex - 1).trim();
    blocks.push({ type, localName, body, startIndex, endIndex });
    resourceHeaderRegex.lastIndex = endIndex;
  }

  return blocks;
}

function normalizeTerraformValue(input: string): string {
  return input.replace(/\s+/g, " ").replace(/"/g, "").trim().toLowerCase();
}

function extractTerraformAttribute(body: string, key: string): string | null {
  const regex = new RegExp(`^\\s*${key}\\s*=\\s*([^\\n#]+)`, "m");
  const match = body.match(regex);
  return match ? match[1].trim() : null;
}

function removeDuplicateTerraformResources(terraform: string): string {
  const blocks = parseTerraformResourceBlocks(terraform);
  if (blocks.length <= 1) return terraform;

  const seen = new Set<string>();
  const rangesToRemove: Array<{ start: number; end: number }> = [];

  for (const block of blocks) {
    if (/\bcount\s*=/.test(block.body) || /\bfor_each\s*=/.test(block.body)) {
      continue;
    }

    const configuredName = extractTerraformAttribute(block.body, "name");
    const semanticName = configuredName
      ? normalizeTerraformValue(configuredName)
      : normalizeTerraformValue(block.localName);
    const bodyFingerprint = normalizeTerraformValue(
      block.body
        .replace(/^\s*name\s*=.*$/gm, "")
        .replace(/^\s*resource_group_name\s*=.*$/gm, "")
    );
    const dedupeKey = `${block.type}|${semanticName}|${bodyFingerprint}`;

    if (seen.has(dedupeKey)) {
      rangesToRemove.push({ start: block.startIndex, end: block.endIndex });
      continue;
    }
    seen.add(dedupeKey);
  }

  if (rangesToRemove.length === 0) return terraform;

  let output = "";
  let cursor = 0;
  for (const range of rangesToRemove.sort((a, b) => a.start - b.start)) {
    output += terraform.slice(cursor, range.start);
    cursor = range.end;
  }
  output += terraform.slice(cursor);

  return output.replace(/\n{3,}/g, "\n\n").trim();
}

function explicitlyRequestsDuplicates(description: string): boolean {
  const normalized = description.toLowerCase();
  const patterns = [
    /\bmultiple\b/,
    /\bduplicate\b/,
    /\b2x\b|\b3x\b|\b4x\b/,
    /\btwo\b|\bthree\b|\bfour\b/,
    /\bprod\b.*\bdev\b|\bdev\b.*\bprod\b/,
    /\bstaging\b.*\bprod\b|\bprod\b.*\bstaging\b/,
    /\bactive[-\s]?active\b/,
    /\bmulti[-\s]?region\b/,
    /\bsecondary\b|\bprimary\b/,
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

function postProcessTerraformFiles(
  files: Array<{ path: string; content: string }>,
  description: string
): Array<{ path: string; content: string }> {
  if (explicitlyRequestsDuplicates(description)) {
    return files;
  }

  return files.map((file) => {
    if (!file.path.toLowerCase().endsWith(".tf")) {
      return file;
    }
    return {
      ...file,
      content: removeDuplicateTerraformResources(file.content),
    };
  });
}

export class OpenAIService {
  private getSystemPrompt(sessionContext?: {
    isExistingRepo?: boolean;
    detectedCloudProvider?: string | null;
    detectedModuleType?: string | null;
    terraformFiles?: string[];
  }): string {
    let basePrompt = `You are an AI DevOps assistant helping users create and manage Terraform configurations.`;

    if (sessionContext?.isExistingRepo && sessionContext.terraformFiles && sessionContext.terraformFiles.length > 0) {
      // Existing repository with Terraform files
      const moduleTypeText = sessionContext.detectedModuleType === 'child' ? 'child module' :
                            sessionContext.detectedModuleType === 'root' ? 'root module' :
                            'Terraform configuration';
      const providerText = sessionContext.detectedCloudProvider ? 
        ` for ${sessionContext.detectedCloudProvider.toUpperCase()}` : '';

      basePrompt += `

DETECTED REPOSITORY CONFIGURATION:
- Module Type: ${moduleTypeText}
- Cloud Provider: ${sessionContext.detectedCloudProvider || 'Not detected'}
- Terraform Files: ${sessionContext.terraformFiles.join(', ')}

Your role is to:
1. Validate the existing Terraform configuration
2. Help users understand what's already in their repository
3. Guide them in adding new resources or child modules as needed
4. Ensure any new code follows the same patterns as existing code

For child modules:
- Help create additional child modules following the same folder structure
- Ensure new modules use "resource" blocks (not "module" blocks)
- Maintain consistency with existing variable and output patterns

For root modules:
- Help add additional resources to the configuration
- Maintain compatibility with existing provider configuration
- Suggest improvements while respecting existing structure

Keep responses conversational and validate existing configuration before suggesting changes.`;
    } else {
      // New repository
      basePrompt += `

Your role is to:
1. Guide users through selecting a repository provider (GitHub or Azure DevOps)
2. Help them select or create repositories
3. Generate Terraform configurations based on their natural language descriptions
4. Provide clear, conversational responses

When generating Terraform code:
- Create main.tf, variables.tf, and dev.terraform.tfvars files
- Use best practices and proper resource naming
- Include relevant variables and outputs
- Format code properly

Keep responses conversational and helpful. Always confirm actions before they're executed.`;
    }

    return basePrompt;
  }

  async chat(messages: ChatMessage[], sessionContext?: {
    isExistingRepo?: boolean;
    detectedCloudProvider?: string | null;
    detectedModuleType?: string | null;
    terraformFiles?: string[];
  }): Promise<string> {
    const systemPrompt = this.getSystemPrompt(sessionContext);

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages
        ],
        temperature: 0.7,
        max_tokens: 4000, // Increased for larger code fixes
      });

      return completion.choices[0]?.message?.content || '';
    } catch (error: any) {
      console.error('OpenAI API error in chat:', error.message);
      // Check for quota exceeded or rate limit errors
      if (error.code === 'insufficient_quota' ||
          error.status === 429 ||
          error.message?.includes('quota') ||
          error.message?.includes('rate limit') ||
          error.message?.includes('exceeded')) {
        const quotaError = new Error('OpenAI quota exceeded - please check your API key billing or try again later');
        (quotaError as any).code = 'QUOTA_EXCEEDED';
        (quotaError as any).isQuotaError = true;
        throw quotaError;
      }
      throw error; // Re-throw to be handled by caller
    }
  }

  async chatWithContext(contextPrompt: string, messages: ChatMessage[]): Promise<string> {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: contextPrompt },
        ...messages
      ],
      temperature: 0.7,
      max_tokens: 500,
    });

    return completion.choices[0]?.message?.content || '';
  }

  generateBackendTf(backendConfig: {
    backendType?: string;
    storageAccount?: string;
    resourceGroup?: string;
    container?: string;
    stateKey?: string;
    // AWS backend fields
    bucket?: string;
    dynamodbTable?: string;
    region?: string;
    encrypt?: boolean;
  }): string {
    if (backendConfig.backendType === 'azurerm') {
      return `terraform {
  backend "azurerm" {
    resource_group_name  = "${backendConfig.resourceGroup || 'terraform-state-rg'}"
    storage_account_name = "${backendConfig.storageAccount || 'tfstate'}"
    container_name       = "${backendConfig.container || 'tfstate'}"
    key                  = "${backendConfig.stateKey || 'terraform.tfstate'}"
    use_azuread_auth     = true
  }
}`;
    } else if (backendConfig.backendType === 's3') {
      // AWS S3 backend with DynamoDB for state locking
      const dynamodbTable = backendConfig.dynamodbTable || 'terraform-state-lock';
      const encrypt = backendConfig.encrypt !== false; // Default to true
      
      return `terraform {
  backend "s3" {
    bucket         = "${backendConfig.bucket || backendConfig.container || 'terraform-state'}"
    key            = "${backendConfig.stateKey || 'terraform.tfstate'}"
    region         = "${backendConfig.region || 'us-east-1'}"
    dynamodb_table = "${dynamodbTable}"
    encrypt        = ${encrypt}
  }
}`;
    }
    return '';
  }

  generateProviderTf(cloudProvider: string): string {
    if (cloudProvider === 'azure') {
      return `terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

provider "azurerm" {
  features {}
}`;
    } else if (cloudProvider === 'aws') {
      return `terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}`;
    } else if (cloudProvider === 'gcp') {
      return `terraform {
  required_version = ">= 1.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}`;
    }
    return '';
  }

  /**
   * Analyze repository Terraform files using AI to detect cloud provider, module type, and other metadata
   */
  /**
   * AI-driven analysis of Terraform code for best practices violations
   */
  async analyzeTerraformBestPractices(
    files: Array<{ fileName: string; content: string }>
  ): Promise<{
    issues: Array<{
      file: string;
      type: string;
      severity: 'error' | 'warning';
      message: string;
      line?: number;
      suggestion?: string;
      codeSnippet?: string;
    }>;
    suggestions: Array<{
      file: string;
      action: string;
      details: string;
    }>;
  }> {
    const mainTf = files.find(f => f.fileName === 'main.tf');
    if (!mainTf) {
      return { issues: [], suggestions: [] };
    }

    const filesContext = files.map(f => `=== ${f.fileName} ===\n${f.content}`).join('\n\n');

    const prompt = `You are a Terraform best practices expert. Analyze the following Terraform code and identify ALL best practices violations.

TERRAFORM BEST PRACTICES TO CHECK:

1. **Multiple Resources of Same Type:**
   - If there are multiple resource blocks of the same type (e.g., 3+ azurerm_storage_account blocks), they should use count or for_each
   - Flag as ERROR if multiple identical resource types exist without count/for_each

2. **Hardcoded Values:**
   - Configurable values (locations, names, tiers, sizes, etc.) should be variables, not hardcoded
   - Use AI understanding to identify which values should be configurable

3. **Code Structure:**
   - Resources should be well-organized
   - Use locals for computed values
   - Avoid duplication

4. **Resource Naming:**
   - Resource names should use variables when appropriate
   - Follow consistent naming patterns

5. **Variable Usage:**
   - All configurable values should use var.* references
   - No hardcoded values in resource blocks

TERRAFORM FILES:
${filesContext}

Analyze the code and return a JSON object with this exact structure:
{
  "issues": [
    {
      "file": "main.tf",
      "type": "multiple_resources_same_type" | "hardcoded_value" | "missing_variable" | "poor_structure" | "naming_issue",
      "severity": "error" | "warning",
      "message": "Clear description of the issue",
      "line": 15,
      "suggestion": "How to fix this issue",
      "codeSnippet": "The problematic code snippet (if applicable)"
    }
  ],
  "suggestions": [
    {
      "file": "main.tf",
      "action": "What action to take",
      "details": "Detailed explanation"
    }
  ]
}

Focus on:
- Multiple resources of same type without count/for_each (ERROR)
- Hardcoded configurable values (WARNING)
- Poor code structure (WARNING)
- Missing variables (WARNING)

Return ONLY valid JSON, no markdown, no explanations.`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a Terraform best practices expert. Always return valid JSON only.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      });

      const content = response.choices[0]?.message?.content || '{}';
      let parsed = JSON.parse(repairJson(content));
      
      return {
        issues: parsed.issues || [],
        suggestions: parsed.suggestions || []
      };
    } catch (error: any) {
      console.error('Error in AI best practices analysis:', error);
      return { issues: [], suggestions: [] };
    }
  }

  /**
   * AI-driven detection of which attributes should be variables
   */
  async detectConfigurableAttributes(
    resourceType: string,
    resourceContent: string
  ): Promise<string[]> {
    const prompt = `You are a Terraform expert. Analyze this Terraform resource and identify which attributes should be variables (configurable) vs which can be hardcoded.

Resource Type: ${resourceType}
Resource Content:
${resourceContent}

Return a JSON array of attribute names that should be variables (e.g., ["name", "location", "account_tier"]).

Consider:
- Attributes that vary by environment (name, location, tier, size)
- Attributes that are configuration choices (replication type, SKU, instance type)
- Attributes that should NOT be variables: resource types, built-in functions, references to other resources

Return ONLY a JSON array, no explanations. Example: ["name", "location", "account_tier"]`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a Terraform expert. Return only a JSON array of attribute names.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' }
      });

      const content = response.choices[0]?.message?.content || '{"attributes": []}';
      const parsed = JSON.parse(repairJson(content));
      return parsed.attributes || parsed || [];
    } catch (error: any) {
      console.error('Error in AI attribute detection:', error);
      return [];
    }
  }

  /**
   * AI-driven fixing of Terraform best practices issues
   */
  async fixTerraformBestPractices(
    files: Array<{ fileName: string; content: string }>,
    issues: Array<{ file: string; type: string; message: string; line?: number }>
  ): Promise<{
    files: Array<{ fileName: string; content: string }>;
    fixes: string[];
  }> {
    const filesContext = files.map(f => `=== ${f.fileName} ===\n${f.content}`).join('\n\n');
    const issuesContext = issues.map((issue, idx) => 
      `${idx + 1}. File: ${issue.file}, Type: ${issue.type}, Line: ${issue.line || 'N/A'}, Issue: ${issue.message}`
    ).join('\n');

    const prompt = `You are a Terraform expert. Fix the following best practices issues in the Terraform code.

TERRAFORM FILES (ALL FILES PROVIDED FOR CONTEXT):
${filesContext}

ISSUES TO FIX:
${issuesContext}

IMPORTANT: You have access to ALL files (main.tf, variables.tf, .tfvars). When fixing issues, you MUST update ALL relevant files.

FIXING RULES:

1. **Multiple Resources of Same Type:**
   - Convert multiple resource blocks of the same type to use count or for_each
   - Choose for_each if you need stable resource identification (e.g., for_each = var.storage_account_names)
   - Choose count if it's a simple numeric requirement (e.g., count = var.storage_account_count)
   - **CRITICAL:** When using count or for_each, you MUST:
     a) Create a variable in variables.tf for the count/for_each value (e.g., variable "storage_account_count" or variable "storage_account_names")
     b) Add the variable value to .tfvars file (e.g., storage_account_count = 5 or storage_account_names = ["sa1", "sa2", "sa3", "sa4", "sa5"])
   - Preserve all resource attributes
   - Update any references to these resources

2. **Hardcoded Values:**
   - Replace hardcoded configurable values with var.* references
   - **MANDATORY:** Add variable declarations to variables.tf (create the file if it doesn't exist)
   - **MANDATORY:** Add variable values to .tfvars file (create the file if it doesn't exist, use "dev.terraform.tfvars" as filename)
   - All configurable values (location, name, tier, etc.) must use variables

3. **Code Structure:**
   - Improve organization while preserving functionality
   - Use locals for computed values
   - Remove duplication

4. **Variable Usage:**
   - Ensure all configurable values use variables
   - Maintain existing variable declarations
   - Add new variables when needed for count/for_each or other configurable values

CRITICAL REQUIREMENTS: 
- Preserve ALL existing functionality
- Keep ALL existing resources
- Only modify what needs to be fixed
- **MANDATORY:** When fixing multiple resources, ALWAYS return variables.tf and .tfvars files (even if they didn't exist before)
- **MANDATORY:** Include ALL files that need updates: main.tf, variables.tf, and .tfvars (use "dev.terraform.tfvars" as filename)
- Return COMPLETE file contents (not just changes)
- Maintain code formatting and style

Return a JSON object with this structure:
{
  "files": [
    {
      "fileName": "main.tf",
      "content": "Complete fixed file content"
    },
    {
      "fileName": "variables.tf",
      "content": "Complete fixed file content (MUST include if variables were added/modified)"
    },
    {
      "fileName": "dev.terraform.tfvars",
      "content": "Complete fixed file content (MUST include if variable values were added/modified)"
    }
  ],
  "fixes": [
    "Description of fix 1",
    "Description of fix 2"
  ]
}

IMPORTANT: If you're fixing multiple resources to use count/for_each, you MUST return all three files (main.tf, variables.tf, dev.terraform.tfvars) with the necessary variables and values.

Return ONLY valid JSON, no markdown, no explanations.`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a Terraform expert. Always return valid JSON with complete file contents.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' }
      });

      const content = response.choices[0]?.message?.content || '{"files": [], "fixes": []}';
      const parsed = JSON.parse(repairJson(content));
      
      return {
        files: parsed.files || [],
        fixes: parsed.fixes || []
      };
    } catch (error: any) {
      console.error('Error in AI best practices fixing:', error);
      return { files: [], fixes: [] };
    }
  }

  async analyzeRepositoryFiles(
    files: Array<{ path: string; content: string }>
  ): Promise<{
    cloudProvider: 'azure' | 'aws' | 'gcp' | null;
    moduleType: 'child' | 'root' | 'empty' | null;
    summary: string;
    detectedResources: string[];
  }> {
    if (files.length === 0) {
      return {
        cloudProvider: null,
        moduleType: 'empty',
        summary: 'No Terraform files found in repository.',
        detectedResources: []
      };
    }

    // Prepare file summaries for AI analysis
    const fileSummaries = files.map(file => {
      const contentPreview = file.content.substring(0, 500);
      const resourceCount = (file.content.match(/resource\s+"[^"]+"/g) || []).length;
      const moduleCount = (file.content.match(/module\s+"[^"]+"/g) || []).length;
      return {
        path: file.path,
        size: file.content.length,
        resourceCount,
        moduleCount,
        preview: contentPreview
      };
    });

    const analysisPrompt = `You are a Terraform expert. Analyze the following Terraform repository files and provide a comprehensive analysis.

Repository Files:
${fileSummaries.map(f => `
File: ${f.path}
Size: ${f.size} characters
Resources: ${f.resourceCount}
Modules: ${f.moduleCount}
Preview:
${f.preview}
${f.size > 500 ? '... (truncated)' : ''}
`).join('\n---\n')}

Your task:
1. Detect the cloud provider (Azure, AWS, or GCP) from:
   - Provider blocks (provider "azurerm", provider "aws", provider "google")
   - Resource types (azurerm_*, aws_*, google_*)
   - Data sources
   - Backend configuration
   - Any other indicators

2. Determine the module type:
   - "child": If files are organized in folders by resource type (e.g., ResourceGroup/main.tf, StorageAccount/main.tf)
   - "root": If files are in root directory with resource blocks or module blocks
   - "empty": If no meaningful Terraform content

3. List all detected resource types (e.g., azurerm_storage_account, azurerm_resource_group)

4. Provide a brief summary of what this repository contains

Return a JSON object with this structure:
{
  "cloudProvider": "azure" | "aws" | "gcp" | null,
  "moduleType": "child" | "root" | "empty" | null,
  "summary": "Brief description of the repository",
  "detectedResources": ["azurerm_storage_account", "azurerm_resource_group", ...]
}

Be precise and base your analysis on the actual file content, not assumptions.`;

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { 
            role: 'system', 
            content: 'You are a Terraform expert. Analyze Terraform files and provide structured JSON responses with cloud provider, module type, and resource detection.' 
          },
          { role: 'user', content: analysisPrompt }
        ],
        temperature: 0.1, // Low temperature for consistent analysis
        max_tokens: 1000,
        response_format: { type: 'json_object' }
      });

      const response = completion.choices[0]?.message?.content || '{}';
      let parsed;
      
      try {
        parsed = JSON.parse(response);
      } catch (parseError) {
        // Try to extract JSON if wrapped in markdown
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error('Failed to parse AI analysis response');
        }
      }

      console.log('\n🤖 AI Repository Analysis:');
      console.log(`   Cloud Provider: ${parsed.cloudProvider || 'Not detected'}`);
      console.log(`   Module Type: ${parsed.moduleType || 'Not detected'}`);
      console.log(`   Resources: ${parsed.detectedResources?.length || 0} detected`);
      console.log(`   Summary: ${parsed.summary?.substring(0, 100) || 'N/A'}...`);

      return {
        cloudProvider: parsed.cloudProvider || null,
        moduleType: parsed.moduleType || null,
        summary: parsed.summary || 'Analysis completed',
        detectedResources: parsed.detectedResources || []
      };
    } catch (error: any) {
      console.error('❌ Error in AI repository analysis:', error);
      // Fallback to null - regex-based analysis will be used instead
      return {
        cloudProvider: null,
        moduleType: null,
        summary: 'AI analysis failed, using regex-based detection',
        detectedResources: []
      };
    }
  }

  async generateTerraform(
    description: string, 
    cloudProvider: string | null, 
    moduleApproach: string | null,
    backendConfig?: {
      hasBackend: boolean;
      backendType?: string;
      storageAccount?: string;
      resourceGroup?: string;
      container?: string;
      stateKey?: string;
      location?: string;
    },
    existingFiles?: Array<{ path: string; content: string }>
  ): Promise<{
    files: Array<{ path: string; content: string }>;
  }> {
    // Skip separate analysis AI call — extract resources via regex and fetch MCP docs directly.
    // The main generation prompt (Step 3) handles the original description without pre-refinement.
    console.log('\n🔍 ========== TERRAFORM GENERATION FLOW ==========');
    console.log(`📝 User Description: "${description}"`);
    console.log(`☁️  Cloud Provider: ${cloudProvider || 'Not specified'}`);
    console.log(`📦 Module Approach: ${moduleApproach || 'Not specified'}`);

    const refinedDescription = description;

    // Extract resource types from description via regex (instant, no AI call needed)
    const resourcesToFetch: string[] = [];
    const resourcePatterns = [
      /azurerm_(\w+)/gi,
      /aws_(\w+)/gi,
      /google_(\w+)/gi,
      /(\w+)\s+(storage|compute|network|container|registry|account|group|service|function|app)/gi,
    ];
    for (const pattern of resourcePatterns) {
      let match;
      while ((match = pattern.exec(description)) !== null) {
        if (match[1] && !resourcesToFetch.includes(match[1])) {
          resourcesToFetch.push(match[1]);
        }
      }
    }

    // Fetch MCP docs immediately (no longer gated on an AI analysis round-trip)
    console.log('\n🔗 Step 1: Fetching Terraform documentation from MCP server...');
    let terraformDocs = '';
    if (resourcesToFetch.length > 0) {
      try {
        const { mcpClient } = await import('./mcp-client');
        terraformDocs = await mcpClient.fetchTerraformDocumentation(resourcesToFetch, cloudProvider);
        console.log(`\n✅ Fetched docs for ${resourcesToFetch.length} resource(s) (${terraformDocs.length} chars)`);
      } catch (mcpError: any) {
        console.error(`\n❌ MCP error: ${mcpError?.message || mcpError} — continuing without docs`);
      }
    } else {
      console.log(`   ⚠️  No specific resources identified, skipping MCP documentation fetch`);
    }
    // Step 2: Generate Terraform code using OpenAI with MCP documentation
    console.log('\n🤖 Step 2: Generating Terraform code with OpenAI...');
    if (terraformDocs) {
      console.log(`   📚 Using latest documentation from Terraform MCP server`);
    } else {
      console.log(`   ⚠️  Using OpenAI's training data (no MCP docs available)`);
    }
    
    const cloudName = cloudProvider === 'azure' ? 'Microsoft Azure' : 
                     cloudProvider === 'aws' ? 'Amazon Web Services (AWS)' : 
                     cloudProvider === 'gcp' ? 'Google Cloud Platform (GCP)' : 
                     'the specified cloud provider';

    /** Keeps generation aligned with user intent — avoids "helpful" extra resources */
    const TERRAFORM_USER_SCOPE = `USER SCOPE (mandatory): Implement ONLY what the user asked for in the description. Do not add extra resources, optional services, environments, or regions unless explicitly requested. Prefer the smallest valid configuration that satisfies the request.

CI / PLAN ACCURACY: Generated code must pass terraform validate and be plannable. For hashicorp/azurerm ~> 4.x use current documented attributes only (avoid deprecated names). Every var.* used in .tf files must be declared in variables.tf with a type; set values in dev.terraform.tfvars or defaults. Resource references must resolve (correct resource types and dependency order). Do not reference undeclared data or resources.`;
    
    // Build enhanced prompt with MCP documentation
    const docsContext = terraformDocs 
      ? `\n\nLATEST TERRAFORM DOCUMENTATION FROM OFFICIAL SOURCES:\n${terraformDocs}\n\nUse this documentation to ensure your code follows the latest Terraform patterns and best practices.`
      : '';
    
    if (moduleApproach === 'child-module') {
      // Child modules use folder-based organization
      const prompt = `Generate Terraform child module code for ${cloudName} based on this description: "${refinedDescription}"${docsContext}

${TERRAFORM_USER_SCOPE}

IMPORTANT: Use the latest Terraform documentation provided above to ensure your code follows current best practices and uses the correct resource syntax.

CRITICAL REQUIREMENTS FOR CHILD MODULES:
1. Child modules MUST use "resource" blocks, NOT "module" blocks
2. Child modules define the actual infrastructure resources directly
3. Each resource type should be in its own folder (e.g., ResourceGroup/, StorageAccount/, FunctionApp/)
4. Each folder contains: main.tf (resource definitions), variables.tf (input variables), outputs.tf (exported values)
5. NO provider configuration blocks in child modules
6. Use input variables for all configurable values
7. Export important attributes as outputs for parent modules

FORBIDDEN IN CHILD MODULES:
- Do NOT use "module" blocks - only "resource" blocks
- Do NOT include provider configuration
- Do NOT include dev.terraform.tfvars (that's for root modules only)

Example correct structure for child modules:
{
  "files": [
    {
      "path": "ResourceGroup/main.tf",
      "content": "resource \\"azurerm_resource_group\\" \\"this\\" {\\n  name     = var.name\\n  location = var.location\\n}"
    },
    {
      "path": "ResourceGroup/variables.tf",
      "content": "variable \\"name\\" {\\n  description = \\"Resource group name\\"\\n  type        = string\\n}"
    },
    {
      "path": "ResourceGroup/outputs.tf",
      "content": "output \\"id\\" {\\n  value = azurerm_resource_group.this.id\\n}"
    }
  ]
}

Organize the resources from the description into appropriate folders. Each folder represents one resource type.
Format your response as JSON with a "files" array. Each file has "path" and "content" keys.`;

      let completion;
      try {
        completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a Terraform expert specializing in reusable child modules. Implement only what the user asked for—no extra resource types or folders. Use ONLY resource blocks in separate folders by type; never use module blocks in child modules.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 16000, // Increased to handle large Terraform files
        response_format: { type: 'json_object' }
      });
      } catch (apiError: any) {
        console.error('❌ OpenAI API error (child-module):', apiError);
        throw new Error(`OpenAI API error: ${apiError?.message || 'Unknown error'}. Please check your API key and try again.`);
      }

      if (!completion || !completion.choices || completion.choices.length === 0) {
        throw new Error('OpenAI returned an empty response. Please try again.');
      }

      const choice = completion.choices[0];
      const response = choice?.message?.content || '';
      const finishReason = choice?.finish_reason;

      console.log(`\n📥 OpenAI Response (child-module):`);
      console.log(`   Finish reason: ${finishReason}`);
      console.log(`   Response length: ${response.length} chars`);

      if (finishReason === 'length') {
        console.warn('⚠️  Response was truncated!');
      }

      if (!response || response.trim().length === 0) {
        throw new Error('OpenAI returned an empty response. Please try again.');
      }

      let jsonText = response.trim();
      if (jsonText.startsWith('```json')) {
        jsonText = jsonText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      if (!jsonText.startsWith('{')) {
        const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonText = jsonMatch[0];
        }
      }

      let parsed;
      try {
        parsed = JSON.parse(jsonText);
      } catch (parseError: any) {
        console.error('❌ Failed to parse OpenAI JSON response (child-module):', parseError);
        console.error('   Response (first 1000 chars):', response.substring(0, 1000));
        
        // Try to repair JSON and parse again
        console.log('   🔧 Attempting to repair JSON...');
        try {
          const repairedJson = repairJson(jsonText);
          parsed = JSON.parse(repairedJson);
          console.log('   ✅ Successfully repaired and parsed JSON');
        } catch (repairError: any) {
          console.error('   ❌ JSON repair failed:', repairError.message);
          throw new Error(`Failed to parse AI response: ${parseError.message}. Please try again.`);
        }
      }
      
      if (!parsed.files || !Array.isArray(parsed.files)) {
        console.error('❌ Invalid response structure from OpenAI (child-module):', parsed);
        throw new Error('AI response missing files array. Please try again.');
      }
      
      // Validate file structure
      const validFiles = parsed.files.filter((file: any) => {
        if (!file.path || !file.content) {
          console.warn('⚠️ Skipping invalid file entry:', file);
          return false;
        }
        return true;
      });
      
      if (validFiles.length === 0) {
        throw new Error('No valid files were generated. Please try again with a more specific description.');
      }
      
      return {
        files: postProcessTerraformFiles(validFiles, refinedDescription)
      };
    } else if (moduleApproach === 'standalone-root') {
      // Standalone root modules use flat structure
      // Check if files already exist - if so, append to them instead of creating new ones
      const existingMainTf = existingFiles?.find(f => f.path === 'main.tf' || f.path.endsWith('/main.tf'));
      const existingVariablesTf = existingFiles?.find(f => f.path === 'variables.tf' || f.path.endsWith('/variables.tf'));
      const existingOutputsTf = existingFiles?.find(f => f.path === 'outputs.tf' || f.path.endsWith('/outputs.tf'));
      // Check for both terraform.tfvars and dev.terraform.tfvars (environment-specific)
      const existingTfvars = existingFiles?.find(f => {
        const path = f.path.toLowerCase();
        return path === 'terraform.tfvars' || 
               path === 'dev.terraform.tfvars' ||
               path.endsWith('/terraform.tfvars') ||
               path.endsWith('/dev.terraform.tfvars');
      });
      
      const hasExistingFiles = existingMainTf || existingVariablesTf || existingOutputsTf || existingTfvars;
      
      let existingFilesContext = '';
      if (hasExistingFiles) {
        existingFilesContext = `\n\nEXISTING FILES IN REPOSITORY:\n`;
        if (existingMainTf) {
          existingFilesContext += `\n--- main.tf (EXISTING) ---\n${existingMainTf.content}\n`;
        }
        if (existingVariablesTf) {
          existingFilesContext += `\n--- variables.tf (EXISTING) ---\n${existingVariablesTf.content}\n`;
        }
        if (existingOutputsTf) {
          existingFilesContext += `\n--- outputs.tf (EXISTING) ---\n${existingOutputsTf.content}\n`;
        }
        if (existingTfvars) {
          const tfvarsFileName = existingTfvars.path.split('/').pop() || existingTfvars.path;
          existingFilesContext += `\n--- ${tfvarsFileName} (EXISTING) ---\n${existingTfvars.content}\n`;
        }
        existingFilesContext += `\n--- END OF EXISTING FILES ---\n\n`;
      }
      
      const prompt = `Generate Terraform standalone root module for ${cloudName} based on this description: "${refinedDescription}"${docsContext}${existingFilesContext}

${TERRAFORM_USER_SCOPE}

IMPORTANT: Use the latest Terraform documentation provided above to ensure your code follows current best practices and uses the correct resource syntax.

${hasExistingFiles ? `🚨🚨🚨 CRITICAL: FILES ALREADY EXIST IN THE REPOSITORY! 🚨🚨🚨

⚠️⚠️⚠️ YOU MUST APPEND, NOT REPLACE! ⚠️⚠️⚠️

This is a STANDALONE ROOT MODULE with EXISTING FILES. You MUST preserve ALL existing content and ONLY append new resources. This is NOT a replacement - it's an addition.

The existing files are shown above in the "EXISTING FILES IN REPOSITORY" section. 
Your response MUST contain the COMPLETE file content: ALL existing content + new additions.
DO NOT generate partial files or only the new additions - include EVERYTHING.

**CRITICAL EXAMPLE FOR ANY NEW RESOURCE:**
If the user requests ANY new resource (e.g., "create AKS cluster", "add storage account", "create VM", "add function app", etc.) and main.tf already has existing resources, your response MUST include:
1. ALL existing resource blocks (copy them EXACTLY as they are - word-for-word)
2. NEW resource blocks (add them at the end, after all existing resources)
3. ALL existing variables from variables.tf (copy them EXACTLY)
4. NEW variables needed for the new resources (add them at the end)
5. ALL existing outputs from outputs.tf (copy them EXACTLY)
6. NEW outputs for the new resources (add them at the end)

**DO NOT** generate only the new resource code - you MUST include EVERYTHING that already exists!
**This applies to ALL resource types: storage accounts, AKS, VMs, function apps, logic apps, databases, networking, etc.**

STRICT REQUIREMENTS (VIOLATION WILL CAUSE DATA LOSS):
1. **main.tf**: 
   - COPY ALL existing resource blocks EXACTLY as they are (word-for-word, character-for-character)
   - ADD ONLY new resource blocks at the end
   - DO NOT modify, remove, or replace any existing resources
   - DO NOT change existing resource names or configurations
   - DO NOT remove any existing code
   - DO NOT reformat or reorganize existing code
   - PRESERVE all existing comments, spacing, and formatting
   - Example: If main.tf has "azurerm_storage_account", COPY IT EXACTLY and add new resources after it
   - **CRITICAL: When adding multiple resources of the same type (e.g., "add 5 storage accounts"), ALWAYS use for_each or count meta-arguments instead of creating multiple resource blocks. This is a Terraform best practice.**
     - Choose for_each when: You need stable resource identification, want to avoid state issues when removing items, or have a map/set of values
     - Choose count when: You have a simple numeric requirement or need sequential numbering
     - Example for_each: "resource \"azurerm_storage_account\" \"example\" { for_each = toset([\"sa1\", \"sa2\", \"sa3\"]) ... }"
     - Example count: "resource \"azurerm_storage_account\" \"example\" { count = 5 ... }"
     - Use each.key/each.value (for_each) or count.index (count) to differentiate resources
     - This makes the code DRY (Don't Repeat Yourself) and easier to maintain
   - **VERIFICATION: Before responding, count the resources in your response. It must have AT LEAST as many resources as the existing file, PLUS the new ones you're adding.**

2. **variables.tf**:
   - COPY ALL existing variable declarations EXACTLY as they are
   - ADD ONLY new variable declarations at the end
   - DO NOT modify or remove existing variables
   - Check if variables already exist before adding (avoid duplicates)

3. **outputs.tf**:
   - COPY ALL existing output blocks EXACTLY as they are
   - ADD ONLY new output blocks at the end
   - DO NOT modify or remove existing outputs

4. **dev.terraform.tfvars** (environment-specific variable values):
   - COPY ALL existing variable assignments EXACTLY as they are
   - ADD or UPDATE only the new variable values
   - DO NOT remove existing assignments
   - Merge new values with existing ones
   - Use "dev.terraform.tfvars" as the filename (NOT "terraform.tfvars")

5. **Resource naming**:
   - Check existing resource names to avoid conflicts
   - Use unique names for new resources
   - Follow the existing naming pattern

6. **Code style**:
   - Match the existing indentation style (spaces/tabs)
   - Match the existing formatting style
   - Maintain consistency with existing code

7. **Best practices for multiple resources**:
   - If the description asks for multiple resources of the same type (e.g., "add 5 storage accounts", "create 3 VMs"), use count or for_each
   - This applies even when appending to existing files
   - Check if existing code already uses count/for_each and follow that pattern if present

VERIFICATION CHECKLIST (MANDATORY - CHECK EACH ITEM):
- [ ] Did you copy ALL existing resources from main.tf EXACTLY as they are?
- [ ] Did you count the existing resources and verify they're all in your response?
- [ ] Did you copy ALL existing variables from variables.tf EXACTLY as they are?
- [ ] Did you copy ALL existing outputs from outputs.tf EXACTLY as they are?
- [ ] Did you add new resources AFTER existing ones (not before, not in between)?
- [ ] Is your file size LARGER than the original (not smaller, not the same)?
- [ ] Did you preserve all existing comments, formatting, and spacing?
- [ ] Did you verify that NO existing resource names were changed?

CRITICAL: If your generated file is SMALLER than or EQUAL to the original, you have REPLACED content instead of APPENDING. This is WRONG and will cause data loss!

BEFORE RESPONDING:
1. Count existing resources in the original file
2. Count resources in your response
3. Your response MUST have: (existing count) + (new count) resources
4. If counts don't match, you've made an error - fix it before responding` : `This is a STANDALONE ROOT MODULE. Generate production-ready Terraform code following ALL best practices:

TERRAFORM BEST PRACTICES (MANDATORY):
1. **Variables**: ALL configurable values in variables.tf, ALL values in dev.terraform.tfvars, NO hardcoded values in main.tf
2. **Multiple Resources**: Use for_each or count for multiple resources of same type - choose based on context (for_each for stable keys, count for simple numeric iteration)
3. **Naming**: Use consistent, descriptive patterns with variables for resource names
4. **Organization**: Separate files (main.tf, variables.tf, outputs.tf), use locals for computed values
5. **Security**: Enable encryption, proper access controls, no hardcoded secrets
6. **Outputs**: Create outputs for important resource attributes with descriptions
7. **Code Quality**: Consistent formatting, no duplication, self-documenting code
8. **Dependencies**: Proper resource dependencies, use data sources for existing resources
9. **Tags/Labels**: Add tags for resource management
10. **Maintainability**: Clear structure, comments for complex logic, easy to modify

CRITICAL: Generate code that follows ALL these best practices. The code must be production-ready and maintainable.`}

CRITICAL: DO NOT include provider configuration or terraform blocks in main.tf - those will be in separate files.

STANDALONE ROOT (NOT AGGREGATED): Put real infrastructure in main.tf using "resource" and "data" blocks for the selected cloud provider. Do NOT use "module" blocks that download remote sources (https://, git::, Azure Blob URLs, or .zip archives). That pattern is for aggregated roots calling packaged modules; standalone root must declare resources directly.

Please provide files:
1. main.tf - Resource definitions ONLY (no provider blocks, no terraform blocks)${hasExistingFiles ? ' - MUST include ALL existing resources + new ones' : ''}
2. variables.tf - Variable declarations (minimal, only for customizable values)${hasExistingFiles ? ' - MUST include ALL existing variables + new ones' : ''}
3. dev.terraform.tfvars - Environment-specific variable values (use "dev.terraform.tfvars" NOT "terraform.tfvars")${hasExistingFiles ? ' - MUST include ALL existing values + new ones' : ''}
4. outputs.tf - Outputs for important resource attributes (optional but recommended)${hasExistingFiles ? ' - MUST include ALL existing outputs + new ones' : ''}

CRITICAL: Always use "dev.terraform.tfvars" as the filename for variable values, NOT "terraform.tfvars".

${hasExistingFiles ? `\n⚠️ REMINDER: Your response must contain COMPLETE files with ALL existing content preserved and new content appended. Verify you have included every resource, variable, and output from the existing files.` : ''}

Format your response as JSON with a "files" array. Each file has "path" and "content" keys.`;

      let completion;
      try {
        completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            { 
              role: 'system', 
              content: hasExistingFiles 
                ? `You are a Terraform expert. CRITICAL: Files already exist in the repository. You MUST preserve ALL existing content and ONLY append new resources. 

STRICT RULES (MANDATORY):
1. COPY all existing content EXACTLY (word-for-word, character-for-character, including all whitespace)
2. ADD new resources ONLY at the end (never before, never in between existing resources)
3. NEVER replace, modify, or remove existing resources, variables, or outputs
4. NEVER reformat, reorganize, or change existing code structure
5. PRESERVE all existing comments, spacing, indentation, and formatting
6. Your response MUST include the COMPLETE file content (existing + new)
7. If your generated file is smaller than or equal to the original, you have FAILED - you replaced instead of appended
8. **CRITICAL: When adding multiple resources of the same type (e.g., "add 5 storage accounts"), ALWAYS use for_each or count meta-arguments instead of creating multiple resource blocks. This is a Terraform best practice.**
   - Choose for_each when: You need stable resource identification, want to avoid state issues when removing items, or have a map/set of values
   - Choose count when: You have a simple numeric requirement or need sequential numbering
   - Example for_each: "resource \"azurerm_storage_account\" \"example\" { for_each = toset([\"sa1\", \"sa2\", \"sa3\"]) ... }"
   - Example count: "resource \"azurerm_storage_account\" \"example\" { count = 5 ... }"
   - Use each.key/each.value (for_each) or count.index (count) to differentiate resources
   - This makes code DRY (Don't Repeat Yourself) and easier to maintain

MANDATORY VERIFICATION BEFORE RESPONDING:
1. Count ALL existing resources in the original file
2. Count ALL resources in your response
3. Your response MUST have: (existing count) + (new count) = total resources
4. Verify file size: Your response MUST be LARGER than the original
5. Verify content: Every existing resource must appear EXACTLY as it was in the original
6. If ANY verification fails, you have made an error - FIX IT before responding

CRITICAL: If you cannot verify that your response includes ALL existing content PLUS new additions, DO NOT respond. Fix your response first.`
                : `You are a Terraform expert specializing in production-ready, best-practice Terraform code.

${TERRAFORM_USER_SCOPE}

Generate code that follows Terraform best practices, but only for resources and settings the user actually requested.

CRITICAL TERRAFORM BEST PRACTICES (MANDATORY):

1. **Variables & Configuration**:
   - ALL configurable values MUST be in variables.tf (never hardcode in main.tf)
   - ALL variable values MUST be in dev.terraform.tfvars
   - Use descriptive variable names with proper types
   - Add descriptions to all variables
   - Use default values only when truly optional
   - Never hardcode: locations, resource names, sizes, tiers, replication types, etc.

2. **Multiple Resources**:
   - When creating multiple resources of the same type, ALWAYS use for_each or count meta-arguments
   - Choose for_each when: You need stable resource identification, want to avoid state issues when removing items, or have a map/set of values
   - Choose count when: You have a simple numeric requirement or need sequential numbering
   - Example for_each: "resource \"azurerm_storage_account\" \"example\" { for_each = toset([\"sa1\", \"sa2\", \"sa3\"]) ... }"
   - Example count: "resource \"azurerm_storage_account\" \"example\" { count = 5 ... }"
   - Use each.key/each.value (for_each) or count.index (count) to differentiate resources
   - This makes code DRY (Don't Repeat Yourself) and maintainable

3. **Resource Naming**:
   - Use consistent, descriptive naming patterns
   - Include environment/region in names when appropriate
   - Use variables for resource names to make them configurable
   - Follow cloud provider naming conventions

4. **Code Organization**:
   - Separate concerns: resources in main.tf, variables in variables.tf, outputs in outputs.tf
   - Use locals for computed values and complex expressions
   - Group related resources logically
   - Add comments for complex logic or business rules

5. **Resource Configuration**:
   - Use data sources for existing resources instead of hardcoding
   - Set proper resource dependencies (implicit or explicit)
   - Configure all security settings (encryption, access controls, etc.)
   - Add tags/labels for resource management
   - Use lifecycle blocks when needed (prevent_destroy, ignore_changes)

6. **Outputs**:
   - Create outputs for important resource attributes
   - Use descriptive output names
   - Add descriptions to outputs
   - Output resource IDs, names, endpoints, etc. that other modules might need

7. **State Management**:
   - Never hardcode state file paths
   - Use backend configuration properly
   - Consider state locking for production

8. **Code Quality**:
   - Use consistent formatting (2 spaces indentation)
   - Avoid duplication - use variables and locals; optional local modules only with source = "./relative/path" — never remote module packages (http/https/git/blob/.zip) in standalone root
   - Keep resource blocks focused and readable
   - Validate inputs where possible
   - Use null_resource sparingly and only when necessary

9. **Security Best Practices**:
   - Never hardcode secrets or sensitive values
   - Use variables or secrets management for sensitive data
   - Enable encryption at rest and in transit
   - Configure proper access controls
   - Follow least privilege principles

10. **Maintainability**:
    - Write self-documenting code with clear variable names
    - Add comments for non-obvious logic
    - Use consistent patterns throughout
    - Make code easy to understand and modify

REMEMBER: Generate production-ready code that follows ALL these best practices. The code should be maintainable, secure, and follow Terraform industry standards.`
            },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 16000, // Increased to handle large Terraform files
        response_format: { type: 'json_object' }
      });
      } catch (apiError: any) {
        console.error('❌ OpenAI API error (standalone-root):', apiError);
        console.error('   Error type:', apiError?.constructor?.name);
        console.error('   Error message:', apiError?.message);
        console.error('   Error code:', apiError?.code);
        throw new Error(`OpenAI API error: ${apiError?.message || 'Unknown error'}. Please check your API key and try again.`);
      }

      // Check if completion is valid
      if (!completion || !completion.choices || completion.choices.length === 0) {
        console.error('❌ Invalid OpenAI response (standalone-root):', completion);
        throw new Error('OpenAI returned an empty response. Please try again.');
      }

      const choice = completion.choices[0];
      const response = choice?.message?.content || '';
      const finishReason = choice?.finish_reason;

      // Log response details for debugging
      console.log(`\n📥 OpenAI Response (standalone-root):`);
      console.log(`   Finish reason: ${finishReason}`);
      console.log(`   Response length: ${response.length} chars`);
      console.log(`   Response preview: ${response.substring(0, 200)}...`);

      // Extract JSON text first (needed for truncation handling)
      let jsonText = response.trim();
      
      // Remove markdown code blocks if present
      if (jsonText.startsWith('```json')) {
        jsonText = jsonText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      // Try to extract JSON object if there's extra text
      if (!jsonText.startsWith('{')) {
        const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonText = jsonMatch[0];
          console.log('   Extracted JSON from response (removed extra text)');
        }
      }

      // Check if response is empty
      if (!response || response.trim().length === 0) {
        console.error('❌ Empty response from OpenAI (standalone-root)');
        throw new Error('OpenAI returned an empty response. Please try again.');
      }

      let parsed;
      
      // Check for truncation
      if (finishReason === 'length') {
        console.error('❌ Response was truncated! JSON is likely incomplete.');
        console.error('   Response length:', response.length, 'chars');
        console.error('   This usually means the generated Terraform code is too large.');
        console.error('   Attempting to repair truncated JSON...');
        
        // Try to repair truncated JSON by closing incomplete structures
        try {
          let repairedJson = jsonText;
          
          // Count open braces and brackets
          const openBraces = (repairedJson.match(/\{/g) || []).length;
          const closeBraces = (repairedJson.match(/\}/g) || []).length;
          const openBrackets = (repairedJson.match(/\[/g) || []).length;
          const closeBrackets = (repairedJson.match(/\]/g) || []).length;
          
          // Close incomplete strings (find unclosed strings)
          let inString = false;
          let escapeNext = false;
          for (let i = repairedJson.length - 1; i >= 0; i--) {
            if (escapeNext) {
              escapeNext = false;
              continue;
            }
            if (repairedJson[i] === '\\') {
              escapeNext = true;
              continue;
            }
            if (repairedJson[i] === '"') {
              inString = !inString;
            }
          }
          
          // If we're in a string, close it
          if (inString) {
            repairedJson += '"';
          }
          
          // Close incomplete arrays/objects
          if (openBrackets > closeBrackets) {
            repairedJson += ']'.repeat(openBrackets - closeBrackets);
          }
          if (openBraces > closeBraces) {
            repairedJson += '}'.repeat(openBraces - closeBraces);
          }
          
          // Try to parse the repaired JSON
          parsed = JSON.parse(repairedJson);
          console.log('   ✅ Successfully repaired truncated JSON');
          
          // Skip to validation if repair succeeded
          if (!parsed.files || !Array.isArray(parsed.files)) {
            throw new Error('Repaired JSON missing files array');
          }
          
          // Filter and return
          const validFiles = parsed.files.filter((file: any) => {
            if (!file.path || !file.content) {
              console.warn('⚠️ Skipping invalid file entry:', file);
              return false;
            }
            const fileName = file.path.split('/').pop();
            return fileName !== 'backend.tf' && fileName !== 'provider.tf' && fileName !== 'terraform.tf';
          });
          
          if (validFiles.length === 0) {
            throw new Error('No valid files in repaired JSON');
          }
          
          return { files: postProcessTerraformFiles(validFiles, refinedDescription) };
        } catch (repairError: any) {
          console.error('   ❌ Failed to repair truncated JSON:', repairError.message);
          throw new Error(`Response was truncated and could not be repaired. The generated Terraform code is too large (${response.length} chars). Please try with fewer resources or split into multiple requests.`);
        }
      }
      try {
        parsed = JSON.parse(jsonText);
      } catch (parseError: any) {
        console.error('❌ Failed to parse OpenAI JSON response (standalone-root):', parseError);
        console.error('   Parse error:', parseError.message);
        console.error('   Response length:', response.length);
        console.error('   Response (first 1000 chars):', response.substring(0, 1000));
        console.error('   Response (last 500 chars):', response.substring(Math.max(0, response.length - 500)));
        console.error('   Extracted JSON text (first 500 chars):', jsonText.substring(0, 500));
        
        // Try to repair JSON and parse again
        console.log('   🔧 Attempting to repair JSON...');
        try {
          const repairedJson = repairJson(jsonText);
          parsed = JSON.parse(repairedJson);
          console.log('   ✅ Successfully repaired and parsed JSON');
        } catch (repairError: any) {
          console.error('   ❌ JSON repair failed:', repairError.message);
          console.error('   Original error:', parseError.message);
          console.error('   Repair error:', repairError.message);
          console.error('   Response length:', response.length);
          console.error('   Repaired JSON (first 1000 chars):', repairJson(jsonText).substring(0, 1000));
          console.error('   Repaired JSON (last 500 chars):', repairJson(jsonText).substring(Math.max(0, repairJson(jsonText).length - 500)));
          
          // Try one more time with more aggressive repair
          try {
            let aggressiveRepair = repairJson(jsonText);
            // Remove any text before first { or [
            const firstBrace = aggressiveRepair.indexOf('{');
            const firstBracket = aggressiveRepair.indexOf('[');
            const startIndex = firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket) ? firstBrace : firstBracket;
            if (startIndex > 0) {
              aggressiveRepair = aggressiveRepair.substring(startIndex);
            }
            // Remove any text after last } or ]
            const lastBrace = aggressiveRepair.lastIndexOf('}');
            const lastBracket = aggressiveRepair.lastIndexOf(']');
            const endIndex = lastBrace !== -1 && (lastBracket === -1 || lastBrace > lastBracket) ? lastBrace + 1 : lastBracket + 1;
            if (endIndex < aggressiveRepair.length) {
              aggressiveRepair = aggressiveRepair.substring(0, endIndex);
            }
            const finalParsed = JSON.parse(aggressiveRepair);
            console.log('   ✅ Successfully parsed with aggressive repair');
            parsed = finalParsed;
          } catch (finalError: any) {
            console.error('   ❌ Aggressive repair also failed:', finalError.message);
            throw new Error(`Failed to parse AI response: ${parseError.message}. The AI may have returned invalid JSON. Please try again.`);
          }
        }
      }
      
      if (!parsed.files || !Array.isArray(parsed.files)) {
        console.error('❌ Invalid response structure from OpenAI (standalone-root):', parsed);
        throw new Error('AI response missing files array. Please try again.');
      }
      
      // Filter out backend.tf, provider.tf, and terraform.tf - these are created during backend configuration
      // and should not be duplicated by AI generation
      const validFiles = parsed.files.filter((file: any) => {
        if (!file.path || !file.content) {
          console.warn('⚠️ Skipping invalid file entry:', file);
          return false;
        }
        const fileName = file.path.split('/').pop();
        return fileName !== 'backend.tf' && fileName !== 'provider.tf' && fileName !== 'terraform.tf';
      });
      
      if (validFiles.length === 0) {
        throw new Error('No valid files were generated. Please try again with a more specific description.');
      }
      
      return {
        files: postProcessTerraformFiles(validFiles, refinedDescription)
      };
    } else if (moduleApproach === 'aggregated-root') {
      // Aggregated root modules use module blocks to call child modules
      console.log(`\n📦 Generating AGGREGATED ROOT MODULE for ${cloudName}`);
      console.log(`   Description length: ${refinedDescription.length} characters`);
      console.log(`   Description: "${refinedDescription.substring(0, 200)}${refinedDescription.length > 200 ? '...' : ''}"`);
      console.log(`   Full description: "${refinedDescription}"`);
      
      if (!refinedDescription || refinedDescription.trim().length < 10) {
        console.error(`\n❌ CRITICAL: Description is too short or empty!`);
        console.error(`   Description: "${refinedDescription}"`);
        throw new Error('Description is required and must be at least 10 characters long for aggregated-root modules.');
      }
      
      const prompt = `Generate Terraform aggregated root module for ${cloudName} based on this description: "${refinedDescription}"${docsContext}

${TERRAFORM_USER_SCOPE}

IMPORTANT: Use the latest Terraform documentation provided above to ensure your code follows current best practices and uses the correct resource syntax.

This is an AGGREGATED ROOT MODULE. You MUST generate the following files with actual module calls based on the description:

REQUIRED FILES (you MUST generate all of these):
1. main.tf - MUST contain "module" blocks that call child modules based on the description. Each resource type mentioned in the description should have a corresponding module block. DO NOT create empty files.
2. variables.tf - MUST contain variable declarations for any values that need to be passed to the child modules
3. dev.terraform.tfvars - MUST contain actual variable values (CRITICAL: Use "dev.terraform.tfvars" NOT "terraform.tfvars")
4. outputs.tf - MUST contain output blocks that aggregate outputs from the child modules

CRITICAL REQUIREMENTS:
- Use "module" blocks to call child modules (assume they exist in subfolders matching the resource type name)
- Use sensible module names and paths (e.g., module "resource_group" { source = "./resource_group" })
- Pass variables to child modules with reasonable defaults
- Aggregate outputs from child modules
- DO NOT include provider configuration or terraform blocks in main.tf - those will be in separate files
- DO NOT generate backend.tf, provider.tf, or terraform.tf files - these already exist
- The description "${refinedDescription}" contains the resources to create - you MUST create module calls for ALL resources mentioned

Example structure:
- If description mentions "resource group" → create module "resource_group" { source = "./resource_group" ... }
- If description mentions "storage account" → create module "storage_account" { source = "./storage_account" ... }
- If description mentions "app service" → create module "app_service" { source = "./app_service" ... }

CRITICAL: Always use "dev.terraform.tfvars" as the filename for variable values, NOT "terraform.tfvars".

Format your response as JSON with a "files" array. Each file has "path" and "content" keys.`;

      let completion;
      try {
        completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a Terraform expert. Follow the user description exactly; do not add modules or resources beyond what they asked for.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 16000, // Increased to handle large Terraform files
        response_format: { type: 'json_object' }
      });
      } catch (apiError: any) {
        console.error('❌ OpenAI API error (aggregated-root):', apiError);
        throw new Error(`OpenAI API error: ${apiError?.message || 'Unknown error'}. Please check your API key and try again.`);
      }

      if (!completion || !completion.choices || completion.choices.length === 0) {
        throw new Error('OpenAI returned an empty response. Please try again.');
      }

      const choice = completion.choices[0];
      const response = choice?.message?.content || '';
      const finishReason = choice?.finish_reason;

      console.log(`\n📥 OpenAI Response (aggregated-root):`);
      console.log(`   Finish reason: ${finishReason}`);
      console.log(`   Response length: ${response.length} chars`);

      if (finishReason === 'length') {
        console.warn('⚠️  Response was truncated!');
      }

      if (!response || response.trim().length === 0) {
        throw new Error('OpenAI returned an empty response. Please try again.');
      }

      let jsonText = response.trim();
      if (jsonText.startsWith('```json')) {
        jsonText = jsonText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      if (!jsonText.startsWith('{')) {
        const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonText = jsonMatch[0];
        }
      }

      let parsed;
      try {
        parsed = JSON.parse(jsonText);
      } catch (parseError: any) {
        console.error('❌ Failed to parse OpenAI JSON response (aggregated-root):', parseError);
        console.error('   Response (first 1000 chars):', response.substring(0, 1000));
        
        // Try to repair JSON and parse again
        console.log('   🔧 Attempting to repair JSON...');
        try {
          const repairedJson = repairJson(jsonText);
          parsed = JSON.parse(repairedJson);
          console.log('   ✅ Successfully repaired and parsed JSON');
        } catch (repairError: any) {
          console.error('   ❌ JSON repair failed:', repairError.message);
          throw new Error(`Failed to parse AI response: ${parseError.message}. Please try again.`);
        }
      }
      
      if (!parsed.files || !Array.isArray(parsed.files)) {
        console.error('❌ Invalid response structure from OpenAI (aggregated-root):', parsed);
        console.error('   Parsed object keys:', Object.keys(parsed));
        throw new Error('AI response missing files array. Please try again.');
      }
      
      console.log(`\n📋 [AGGREGATED-ROOT] Raw AI response contains ${parsed.files.length} file(s):`);
      parsed.files.forEach((file: any, idx: number) => {
        const fileName = file.path ? file.path.split('/').pop() : 'unknown';
        console.log(`   ${idx + 1}. ${file.path || 'NO PATH'} (${file.content ? file.content.length : 0} chars)`);
      });
      
      // Filter out backend.tf, provider.tf, and terraform.tf - these are created during backend configuration
      // and should not be duplicated by AI generation
      const validFiles = parsed.files.filter((file: any) => {
        if (!file.path || !file.content) {
          console.warn('⚠️ Skipping invalid file entry:', file);
          return false;
        }
        const fileName = file.path.split('/').pop();
        const isBackendFile = fileName === 'backend.tf' || fileName === 'provider.tf' || fileName === 'terraform.tf';
        if (isBackendFile) {
          console.log(`   ⏭️  Filtering out backend file: ${fileName}`);
        }
        return !isBackendFile;
      });
      
      console.log(`\n✅ [AGGREGATED-ROOT] After filtering, ${validFiles.length} valid file(s) remain:`);
      validFiles.forEach((file: any, idx: number) => {
        console.log(`   ${idx + 1}. ${file.path} (${file.content.length} chars)`);
      });
      
      // Check for required files
      const requiredFiles = ['main.tf', 'variables.tf', 'dev.terraform.tfvars', 'outputs.tf'];
      const generatedFileNames = validFiles.map((f: any) => f.path.split('/').pop() || f.path);
      const missingFiles = requiredFiles.filter(req => !generatedFileNames.includes(req));
      if (missingFiles.length > 0) {
        console.error(`\n❌ [AGGREGATED-ROOT] MISSING REQUIRED FILES: ${missingFiles.join(', ')}`);
        console.error(`   Generated files: ${generatedFileNames.join(', ')}`);
        console.error(`   This means the AI did not generate all required files!`);
      } else {
        console.log(`\n✅ [AGGREGATED-ROOT] All required files present: ${requiredFiles.join(', ')}`);
      }
      
      if (validFiles.length === 0) {
        console.error(`\n❌ [AGGREGATED-ROOT] CRITICAL: No valid files after filtering!`);
        console.error(`   Raw files count: ${parsed.files.length}`);
        console.error(`   This means either:`);
        console.error(`   1. AI only generated backend files (backend.tf, provider.tf, terraform.tf)`);
        console.error(`   2. All files were invalid (missing path or content)`);
        throw new Error('No valid files were generated. Please try again with a more specific description.');
      }
      
      return {
        files: postProcessTerraformFiles(validFiles, refinedDescription)
      };
    } else {
      // Default fallback
      const prompt = `Generate Terraform configuration files for ${cloudName} based on this description: "${refinedDescription}"${docsContext}

IMPORTANT: Use the latest Terraform documentation provided above to ensure your code follows current best practices and uses the correct resource syntax.

Please provide files:
1. main.tf - Resource definitions
2. variables.tf - Variable declarations
3. dev.terraform.tfvars - Environment-specific variable values (CRITICAL: Use "dev.terraform.tfvars" NOT "terraform.tfvars")

CRITICAL: Always use "dev.terraform.tfvars" as the filename for variable values, NOT "terraform.tfvars".

Format your response as JSON with a "files" array. Each file has "path" and "content" keys.`;

      let completion;
      try {
        completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a Terraform expert. Generate well-structured, production-ready Terraform code.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 16000, // Increased to handle large Terraform files
        response_format: { type: 'json_object' }
      });
      } catch (apiError: any) {
        console.error('❌ OpenAI API error (default):', apiError);
        throw new Error(`OpenAI API error: ${apiError?.message || 'Unknown error'}. Please check your API key and try again.`);
      }

      if (!completion || !completion.choices || completion.choices.length === 0) {
        throw new Error('OpenAI returned an empty response. Please try again.');
      }

      const choice = completion.choices[0];
      const response = choice?.message?.content || '';
      const finishReason = choice?.finish_reason;

      console.log(`\n📥 OpenAI Response (default):`);
      console.log(`   Finish reason: ${finishReason}`);
      console.log(`   Response length: ${response.length} chars`);

      if (finishReason === 'length') {
        console.error('❌ Response was truncated! JSON is likely incomplete.');
        console.error('   Response length:', response.length, 'chars');
        console.error('   Attempting to repair truncated JSON...');
        
        // Try to repair truncated JSON by closing incomplete structures
        let jsonText = response.trim();
        if (jsonText.startsWith('```json')) {
          jsonText = jsonText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        } else if (jsonText.startsWith('```')) {
          jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```$/, '');
        }
        
        try {
          // Count open braces and brackets
          const openBraces = (jsonText.match(/\{/g) || []).length;
          const closeBraces = (jsonText.match(/\}/g) || []).length;
          const openBrackets = (jsonText.match(/\[/g) || []).length;
          const closeBrackets = (jsonText.match(/\]/g) || []).length;
          
          // Close incomplete strings (find unclosed strings at the end)
          let inString = false;
          let escapeNext = false;
          for (let i = jsonText.length - 1; i >= 0; i--) {
            if (escapeNext) {
              escapeNext = false;
              continue;
            }
            if (jsonText[i] === '\\') {
              escapeNext = true;
              continue;
            }
            if (jsonText[i] === '"') {
              inString = !inString;
              break;
            }
          }
          
          // If we're in a string, close it
          if (inString) {
            jsonText += '"';
          }
          
          // Close incomplete arrays/objects
          if (openBrackets > closeBrackets) {
            jsonText += ']'.repeat(openBrackets - closeBrackets);
          }
          if (openBraces > closeBraces) {
            jsonText += '}'.repeat(openBraces - closeBraces);
          }
          
          // Try to parse the repaired JSON
          const parsed = JSON.parse(jsonText);
          console.log('   ✅ Successfully repaired truncated JSON');
          if (!parsed.files || !Array.isArray(parsed.files)) {
            throw new Error('Repaired JSON missing files array');
          }
          return { files: postProcessTerraformFiles(parsed.files, refinedDescription) };
        } catch (repairError: any) {
          console.error('   ❌ Failed to repair truncated JSON:', repairError.message);
          throw new Error(`Response was truncated and could not be repaired. The generated Terraform code is too large (${response.length} chars). Please try with fewer resources or split into multiple requests.`);
        }
      }

      if (!response || response.trim().length === 0) {
        throw new Error('OpenAI returned an empty response. Please try again.');
      }

      let jsonText = response.trim();
      if (jsonText.startsWith('```json')) {
        jsonText = jsonText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      if (!jsonText.startsWith('{')) {
        const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonText = jsonMatch[0];
        }
      }

      let parsed;
      try {
        parsed = JSON.parse(jsonText);
      } catch (parseError: any) {
        console.error('❌ Failed to parse OpenAI JSON response (default):', parseError);
        console.error('   Response (first 1000 chars):', response.substring(0, 1000));
        
        // Try to repair JSON and parse again
        console.log('   🔧 Attempting to repair JSON...');
        try {
          const repairedJson = repairJson(jsonText);
          parsed = JSON.parse(repairedJson);
          console.log('   ✅ Successfully repaired and parsed JSON');
        } catch (repairError: any) {
          console.error('   ❌ JSON repair failed:', repairError.message);
          throw new Error(`Failed to parse AI response: ${parseError.message}. Please try again.`);
        }
      }
      
      if (!parsed.files || !Array.isArray(parsed.files)) {
        console.error('❌ Invalid response structure from OpenAI (default):', parsed);
        throw new Error('AI response missing files array. Please try again.');
      }
      
      // Validate file structure
      const validFiles = parsed.files.filter((file: any) => {
        if (!file.path || !file.content) {
          console.warn('⚠️ Skipping invalid file entry:', file);
          return false;
        }
        return true;
      });
      
      if (validFiles.length === 0) {
        throw new Error('No valid files were generated. Please try again with a more specific description.');
      }
      
      return {
        files: postProcessTerraformFiles(validFiles, refinedDescription)
      };
    }
  }

  async generateCommitMessage(files: { name: string; content: string }[]): Promise<string> {
    // Analyze file contents to understand what changed
    const fileSummaries = files.map(f => {
      const content = f.content || '';
      const lines = content.split('\n').length;
      
      // Extract resource types from Terraform files
      const resourceMatches = content.match(/resource\s+"([^"]+)"\s+"([^"]+)"/g) || [];
      const resources = resourceMatches.map(m => {
        const match = m.match(/resource\s+"([^"]+)"\s+"([^"]+)"/);
        return match ? `${match[1]}.${match[2]}` : null;
      }).filter(Boolean);
      
      return {
        name: f.name,
        lines,
        resources: resources.length > 0 ? resources : null
      };
    });
    
    const filesDescription = fileSummaries.map(f => {
      if (f.resources) {
        return `${f.name} (${f.resources.join(', ')})`;
      }
      return f.name;
    }).join(', ');
    
    const prompt = `Generate a concise git commit message for these Terraform file changes:

Files: ${filesDescription}

Analyze the changes and create a descriptive commit message that explains what infrastructure resources are being added, modified, or updated. The message should be:
- Clear and descriptive
- Under 72 characters (preferred) or maximum 100 characters
- Follow conventional commit format if possible
- Focus on what was changed, not how

Examples:
- "Add storage account for blob storage"
- "Append storage account to existing infrastructure"
- "Update Terraform configuration with new resources"

Generate only the commit message, nothing else.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: prompt }
      ],
      temperature: 0.5,
      max_tokens: 100,
    });

    const message = completion.choices[0]?.message?.content?.trim() || 'Add Terraform configuration';
    console.log(`📝 AI-generated commit message: "${message}"`);
    return message;
  }

  /**
   * Generate variable declarations for missing variables
   */
  async generateVariableDeclarations(
    variableNames: string[],
    mainTfContent: string
  ): Promise<string> {
    const prompt = `You are a Terraform expert. Generate variable declarations for the following variables that are referenced in main.tf but not declared in variables.tf.

Variables to declare: ${variableNames.join(', ')}

Main.tf content (for context):
\`\`\`
${mainTfContent.substring(0, 2000)}${mainTfContent.length > 2000 ? '...' : ''}
\`\`\`

Generate proper variable declarations following Terraform best practices:
1. Use appropriate types (string, number, bool, list, map, object)
2. Add descriptions
3. Only add defaults if they make sense (prefer no defaults for required variables)
4. Use proper formatting

Return ONLY the variable declarations, one per variable, in this format:
variable "variable_name" {
  type        = <type>
  description = "<description>"
  # default     = <value> (only if needed)
}

Return ONLY the Terraform code, no markdown, no explanations.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a Terraform expert. Generate clean, production-ready variable declarations.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content?.trim() || '';
  }

  /**
   * Generate .tfvars values for variables based on context
   */
  async generateTfvarsValues(
    variableNames: string[],
    mainTfContent: string,
    userDescription: string
  ): Promise<string> {
    const prompt = `You are a Terraform expert. Generate sensible default values for the following variables in .tfvars format.

Variables to populate: ${variableNames.join(', ')}

Main.tf content (for context):
\`\`\`
${mainTfContent.substring(0, 2000)}${mainTfContent.length > 2000 ? '...' : ''}
\`\`\`

User's original request: "${userDescription}"

Generate sensible default values based on:
1. The variable name (e.g., "storage_account_count" = 5 if user asked for 5 storage accounts)
2. The context from main.tf (e.g., location, naming patterns)
3. Terraform best practices

Return ONLY the .tfvars assignments in this format:
variable_name = "value"
variable_name = 5
variable_name = true
variable_name = ["item1", "item2"]
variable_name = { key = "value" }

Return ONLY the Terraform code, no markdown, no explanations.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a Terraform expert. Generate sensible default values for .tfvars files based on context.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content?.trim() || '';
  }

  /**
   * MigrateOps: main.tf is often literal-only (no var.*). `ensureVariablesTfFromMainTf` only runs when
   * var references exist — this pass fills variables.tf + dev.terraform.tfvars from tunable literals.
   * Does not rewrite main.tf (avoids breaking imports/addresses).
   */
  async generateMigrateOpsVariablesTfvarsFromMainLiterals(mainTfContent: string): Promise<{
    variablesTf: string;
    tfvars: string;
  }> {
    const maxChars = 120000;
    const body =
      mainTfContent.length > maxChars
        ? `${mainTfContent.slice(0, maxChars)}\n\n# ... [truncated for AI — ${mainTfContent.length} chars total]`
        : mainTfContent;

    const prompt = `You are a Terraform expert for hashicorp/azurerm ~> 4.x (MigrateOps: imported live Azure resources).

main.tf below uses hardcoded values. Produce:
1) variables_tf — Declare Terraform variables for tunable values that appear in main.tf: resource names, SKU/tier/size, image names/tags, hostnames, storage account names, service plan identifiers, container app settings, etc.
2) dev_terraform_tfvars — Assign EVERY variable you declared with the same values as currently used in main.tf (so operators can override per environment).

STRICT RULES:
- Do NOT declare variables for resource \`location = "..."\` arguments — locations must stay literal in main.tf; never emit a "location" variable for azurerm resources.
- Use snake_case variable names. Include \`type\` and \`description\` on each variable. Use \`default =\` in the variable block with the exact literal from main.tf where appropriate so terraform validate works even before editing main to use var.*.
- dev_terraform_tfvars: one \`name = value\` per line; match every variable name. Use quotes for strings. Include a short header comment.
- If main.tf is very small, still emit at least the obvious naming/SKU variables.
- Output valid HCL only in the JSON strings (no markdown fences inside values).

Return a JSON object ONLY:
{
  "variables_tf": "...",
  "dev_terraform_tfvars": "..."
}

main.tf:
\`\`\`hcl
${body}
\`\`\``;

    const syncModel = process.env.MIGRATEOPS_SYNC_VARS_MODEL || 'gpt-4o-mini';
    const completion = await aiChatCompletion(
      {
        model: syncModel,
        messages: [
          {
            role: 'system',
            content:
              'You output only valid JSON with keys variables_tf and dev_terraform_tfvars. Values are Terraform HCL snippets.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.15,
        max_tokens: 8192,
        response_format: { type: 'json_object' },
      },
      { timeout: parseInt(process.env.MIGRATEOPS_SYNC_VARS_TIMEOUT_MS || '120000', 10), maxRetries: 1 }
    );

    const raw = completion.choices[0]?.message?.content || '{}';
    let parsed: { variables_tf?: string; dev_terraform_tfvars?: string };
    try {
      parsed = JSON.parse(repairJson(raw));
    } catch {
      return { variablesTf: '', tfvars: '' };
    }

    return {
      variablesTf: String(parsed.variables_tf || '').trim(),
      tfvars: String(parsed.dev_terraform_tfvars || '').trim(),
    };
  }

  /**
   * AI-driven resource extraction from natural language description
   */
  async extractResourcesFromDescription(
    description: string,
    cloudProvider: string | null
  ): Promise<string[]> {
    const providerContext = cloudProvider ? ` for ${cloudProvider.toUpperCase()}` : '';
    const prompt = `You are a Terraform expert. Analyze the following user description and extract a list of specific Terraform resource types (e.g., "azurerm_resource_group", "azurerm_storage_account", "aws_s3_bucket", "google_compute_instance") that the user wants to create${providerContext}.

User Description: "${description}"

Guidelines:
1. Return ONLY a list of actual Terraform resource types.
2. If the user uses natural language like "storage account", map it to the correct resource type (e.g., "azurerm_storage_account" for Azure).
3. Be as specific as possible based on the description.
4. If a resource type is mentioned multiple times, include it only once.

Return a JSON object with this structure:
{
  "resources": ["resource_type_1", "resource_type_2", ...]
}

Return ONLY valid JSON, no markdown, no explanations.`;

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a Terraform expert. Extract resource types and return them as JSON.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      });

      const response = completion.choices[0]?.message?.content || '{"resources": []}';
      const parsed = JSON.parse(repairJson(response));
      return parsed.resources || [];
    } catch (error: any) {
      console.error('❌ Error extracting resources with AI:', error);
      return [];
    }
  }

  /**
   * Second AI pass: repair HCL for provider validity, required arguments, and import alignment.
   */
  private async refineMigrateOpsTerraformFiles(
    files: Array<{ path: string; content: string }>,
    scopeSection: string,
    azureRulesSection: string
  ): Promise<Array<{ path: string; content: string }>> {
    const paths = files.map((f) => f.path);
    const bundle = files
      .map((f) => `=== FILE: ${f.path} ===\n${f.content}`)
      .join('\n\n');
    const bundleCap = 220_000;
    const bundleTrimmed =
      bundle.length > bundleCap ? `${bundle.slice(0, bundleCap)}\n\n... [trimmed for refine context]` : bundle;

    const prompt = `You are a senior Terraform engineer. These files were generated from LIVE Azure Resource Manager JSON. Revise them so they are as close as possible to a successful \`terraform validate\` and \`terraform plan\` with Terraform 1.6+ and hashicorp/azurerm ~> 4.x.

${scopeSection}

${azureRulesSection}

REFINE RULES:
1. Use ONLY real azurerm resource types from the Terraform Registry — never invented names.
2. \`azurerm_container_app\` MUST have: resource_group_name, container_app_environment_id, revision_mode, template { container { ... } }. **Every \`container\` block MUST include \`cpu\` and \`memory\`** (provider-required). Add them if missing.
3. Every import block in imports.tf: \`to\` must be an **unquoted** address (e.g. to = azurerm_foo.bar), matching main.tf. Never quote the \`to\` value.
4. Preserve resource labels when possible; fix bodies and attribute names.
5. **Enforce standard generated tags** on resources that support tags:
   \`tags = { ManagedBy = "MigrateOps", MigrateOpsImport = "true" }\`.
   Do not attempt to mirror Azure Portal tags.
6. If a resource cannot be represented faithfully without external data, add \`# migrateops: TODO\` and minimal valid stub — do not leave invalid HCL.
7. Return JSON: { "files": [ { "path": string, "content": string } ] } with EXACTLY these paths: ${paths.map((p) => JSON.stringify(p)).join(', ')}

--- FILES ---
${bundleTrimmed}`;

    try {
      const completion = await aiChatCompletion(
        {
          model: MIGRATEOPS_REFINE_MODEL,
          messages: [
            {
              role: 'system',
              content:
                'You output only valid JSON with a "files" array. You fix Terraform HCL for Azure; you never invent resource types. For azurerm_container_app, every template.container block must set cpu and memory.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.05,
          max_tokens: MIGRATEOPS_MAX_OUTPUT_TOKENS,
          response_format: { type: 'json_object' },
        },
        { timeout: MIGRATEOPS_AI_TIMEOUT_MS, maxRetries: 1 }
      );

      const response = completion.choices[0]?.message?.content || '{"files":[]}';
      const parsed = JSON.parse(repairJson(response));
      const out = parsed.files;
      if (!Array.isArray(out) || out.length === 0) {
        return files;
      }
      const refinedByPath = new Map<string, string>();
      for (const item of out) {
        if (item?.path && typeof item.content === 'string') {
          refinedByPath.set(item.path, item.content);
        }
      }
      const merged = files.map((f) =>
        refinedByPath.has(f.path) ? { path: f.path, content: refinedByPath.get(f.path)! } : f
      );
      return merged.map((f) =>
        f.path.split('/').pop()?.toLowerCase() === 'main.tf'
          ? { ...f, content: ensureContainerAppContainerCpuMemory(f.content) }
          : f
      );
    } catch (err: any) {
      console.warn('[MigrateOps] Refine pass failed, using first-pass files:', err?.message || err);
      return files;
    }
  }

  async generateTerraformFromLiveState(
    cloudProvider: string,
    resourcesJson: any[],
    options?: {
      resourceGroupName?: string;
      resourceGroupLocation?: string;
    }
  ): Promise<{
    files: Array<{ path: string; content: string }>;
  }> {
    console.log(`\n🔍 ========== MIGRATE-OPS GENERATION ==========`);
    console.log(`☁️  Cloud Provider: ${cloudProvider}`);
    console.log(`📦 Resources Count: ${resourcesJson.length}`);
    console.log(
      `   Models: generate=${MIGRATEOPS_MODEL} refine=${MIGRATEOPS_REFINE_MODEL} (set MIGRATEOPS_MODEL / MIGRATEOPS_REFINE_MODEL to override)`
    );

    const { payload: resourcesPayload, perResourceCapUsed, truncatedGlobally } =
      buildMigrateOpsAzureResourcePayloadString(resourcesJson);
    console.log(
      `   Live payload: ${resourcesPayload.length} chars, per-resource property cap=${perResourceCapUsed}, global_truncated=${truncatedGlobally}`
    );

    const rgName = options?.resourceGroupName?.trim();
    const rgLoc = options?.resourceGroupLocation?.trim();
    const scopeSection =
      rgName && rgLoc
        ? `
SCOPE (non-negotiable — this MigrateOps run is a single resource group):
- Resource group name: "${rgName}"
- The RESOURCE GROUP itself is in location: "${rgLoc}" — use this ONLY for the azurerm_resource_group block.
- ⚠️ LOCATION RULE: Every OTHER resource (service plans, web apps, storage accounts, container apps, etc.) MUST use the \`location\` field from its own JSON entry, NOT "${rgLoc}". Resources can be in different Azure regions than their resource group. Hardcode each resource's own location as a string literal (e.g. location = "centralus") — never use var.location or the resource group location for child resources.
- You MUST declare exactly one root resource group block:
  resource "azurerm_resource_group" "migrate_scope" {
    name     = "${rgName}"
    location = "${rgLoc}"
  }
- Every \`resource_group_name = ...\` in this scope must be \`azurerm_resource_group.migrate_scope.name\`.
`
        : '';

    const perResourceGuidance = buildSchemaGuidanceForResources(resourcesJson);

    const azureRulesSection = `AZURERM 4.x MIGRATION RULES:
- Target provider: hashicorp/azurerm ~> 4.x. Use ONLY real resource types from the Terraform Registry.
- **TAGS:** Do NOT copy tags from Azure JSON. Generate standard tags in Terraform for every azurerm resource that supports tags:
  \`tags = { ManagedBy = "MigrateOps", MigrateOpsImport = "true" }\`
  Keep these keys/values stable unless user explicitly asks for different tag policy.
- **\`migrateopsResolvedTerraform\` (when present) is authoritative.** The server pre-computed these values from live ARM JSON using the same rules Terraform needs (e.g. Container App \`ingress.target_port\`, \`revision_mode\`). Copy numbers and booleans from this object into HCL — do NOT override them with guesses from raw \`properties\` when they disagree.
- Each resource may include \`migrateopsSchemaGuidance\` — per-resource-type cheat-sheet (Terraform type, ARM mappings, renames, removed blocks). **Follow it strictly.**
- If \`migrateopsSchemaGuidance\` lists removed attributes or blocks, do NOT include them; use the replacement noted in the guidance.
- Cross-check every \`azurerm_resource_group.<label>\` reference: the matching resource block MUST exist in main.tf.
- Map fields from \`properties\`, \`migrateopsTerraformHints\`, and \`migrateopsResolvedTerraform\` into Terraform arguments. Prefer resolved + hints over re-parsing huge raw properties blobs.
- If a resource type has no guidance attached, use the official Terraform Registry documentation for azurerm 4.x. If unsure about an attribute, add \`# TODO: verify\` rather than guessing.
${perResourceGuidance}`;

    const prompt = `MIGRATION OBJECTIVE: Reverse-engineer LIVE Azure resources into Terraform HCL so they can be imported into state via \`terraform import\`. The focus is migration fidelity — every resource must map cleanly to its Azure counterpart.

Live Resources (JSON — includes \`migrateopsSchemaGuidance\`, \`migrateopsTerraformHints\`, and when available \`migrateopsResolvedTerraform\` with server-side resolved values):
\`\`\`json
${resourcesPayload}
\`\`\`
${scopeSection}

${azureRulesSection}

MIGRATION RULES:
1. For each resource, check its \`migrateopsSchemaGuidance.terraformType\` and use that exact type. Follow \`armToTerraformMap\` to translate ARM property paths into Terraform argument names.
2. If \`renamedIn4x\` shows an old→new mapping, ONLY use the new name. If \`removedIn4x\` lists an attribute, do NOT include it.
3. Prefer \`migrateopsResolvedTerraform\` (authoritative), then migrateopsTerraformHints, then properties / sku / location / id — never invent numbers when resolved values exist.
3b. **Tags:** For each Terraform resource type that supports tags, emit exactly:
    \`tags = { ManagedBy = "MigrateOps", MigrateOpsImport = "true" }\`.
    Do not read or mirror tags from Azure scan JSON.
4. Drop only read-only noise (etag, internal IDs). Keep anything needed for a faithful plan.
5. Extract repeated / tunable values into variables.tf and dev.terraform.tfvars.
   **EXCEPTION — location is NEVER a variable**: Every resource MUST hardcode its own \`location\` directly from the \`location\` field in the JSON (e.g. \`location = "centralus"\`). Resources in the same resource group can have DIFFERENT locations in Azure. Never use \`var.location\` for any resource — it causes forces-replacement when the resource's actual location differs from the resource group. The \`location\` variable in variables.tf is only for informational reference; no resource block should reference it.
6. Output files:
   - main.tf — resource, data, locals, output blocks only (no terraform or provider block)
   - variables.tf, dev.terraform.tfvars, outputs.tf
7. imports.tf: one import block per managed resource in main.tf:
   - \`to\` = **unquoted** Terraform resource address (e.g. to = azurerm_resource_group.migrate_scope)
   - \`id\` = quoted Azure resource ARM ID string
   - The import \`id\` MUST be the exact \`id\` field from the resource JSON (the Azure ARM resource ID).

AZURERM_CONTAINER_APP CRITICAL RULES (for microsoft.app/containerapps resources):
0. **Registry / ACR auth:** ARM lists \`configuration.registries[]\` with \`passwordSecretRef\` (camelCase). In Terraform the block is \`registry { server = "..." username = "..." password_secret_name = "..." }\` — the argument is **password_secret_name** only. There is NO \`password_secret_ref\` in the provider; emitting it causes immediate plan failure. Use \`migrateopsResolvedTerraform.azurerm_container_app.registry_blocks\` or \`migrateopsTerraformHints.containerApp.registriesForTerraform\` for exact values.
0b. **Ingress transport:** In \`ingress {}\`, \`transport\` must be one of **auto**, **http**, **http2**, **tcp** (all **lowercase**). ARM often returns \`Auto\` or \`Http\` — use \`migrateopsResolvedTerraform.azurerm_container_app.ingress.transport\` or \`migrateopsTerraformHints.containerApp.ingressTransportForTerraform\` — never PascalCase strings.
A. env { secret_name = "x" } — NOT secretRef = "x". The argument name is secret_name.
B. NO scale {} block exists. Use min_replicas and max_replicas directly inside template {}.
C. NO probes {} block exists. Use liveness_probe {}, readiness_probe {}, startup_probe {} inside container {}.
D. ingress {} and secret {} are TOP-LEVEL on the resource — NOT inside template {}.
E. ingress {} requires target_port (1–65535, NEVER 0). **Use migrateopsResolvedTerraform.azurerm_container_app.ingress.target_port** when present; it already resolves ingress → probes → container ports → env PORT. The field \`_resolvedFrom\` explains the source.
F. Secrets: declare at top level as secret { name = "x", value = "y" }; reference in env as secret_name = "x".
I. registry {} blocks (ACR pull): use password_secret_name = "..." (name of a top-level secret) — NEVER password_secret_ref (unsupported).
G. NEVER include custom_domain {} inside ingress {} — it is a computed read-only attribute exported by the provider. Remove it entirely from the HCL. Also never set fqdn inside ingress {}.
H. PROBE ATTRIBUTE NAMES inside liveness_probe {}, readiness_probe {}, startup_probe {} — ONLY these exact names work:
   transport, port, path, initial_delay, interval_seconds, timeout, failure_count_threshold
   Readiness ONLY (omit on liveness/startup): success_count_threshold
   NEVER use: timeout_seconds, failure_threshold, success_threshold, initial_delay_seconds, period_seconds

CRITICAL FORMATTING:
Return a pure JSON object: { "files": [ { "path": string, "content": string } ] }. No markdown.

Example:
{
  "files": [
    { "path": "main.tf", "content": "..." },
    { "path": "variables.tf", "content": "..." },
    { "path": "dev.terraform.tfvars", "content": "..." },
    { "path": "outputs.tf", "content": "..." },
    { "path": "imports.tf", "content": "..." }
  ]
}`;

    try {
      const completion = await aiChatCompletion(
        {
          model: MIGRATEOPS_MODEL,
          messages: [
            {
              role: 'system',
              content:
                'You are an expert Terraform migration engineer. You output only valid JSON with a "files" array. Your job is to reverse-engineer live Azure resources into Terraform HCL that is valid for hashicorp/azurerm ~> 4.x and ready for `terraform import`. When `migrateopsResolvedTerraform` is present on a resource, treat it as the single source of truth for those fields (pre-computed from ARM). Use `migrateopsSchemaGuidance` for types and renames. Never invent resource type names.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.08,
          max_tokens: MIGRATEOPS_MAX_OUTPUT_TOKENS,
          response_format: { type: 'json_object' },
        },
        { timeout: MIGRATEOPS_AI_TIMEOUT_MS, maxRetries: 2 }
      );

      let response = completion.choices[0]?.message?.content || '{"files":[]}';
      const parsed = JSON.parse(repairJson(response));
      let files: Array<{ path: string; content: string }> = parsed.files || [];

      if (MIGRATEOPS_REFINE_ENABLED && files.length > 0) {
        console.log('[MigrateOps] Running refine pass...');
        files = await this.refineMigrateOpsTerraformFiles(files, scopeSection, azureRulesSection);
      }

      files = files.map((f) =>
        f.path.split('/').pop()?.toLowerCase() === 'imports.tf'
          ? { ...f, content: fixImportBlocksQuotedToAddresses(f.content) }
          : f
      );

      return { files };
    } catch (error: any) {
      console.error('❌ Failed to generate Terraform from live state:', error);
      throw new Error(`Failed to generate Terraform from live state: ${error.message}`);
    }
  }

  /**
   * AI-driven repair: reviews generated HCL against azurerm 4.x schema guidance
   * and fixes attribute/block errors the model may have introduced.
   * Replaces hardcoded regex patching — the AI is the intelligent layer.
   *
   * @param ciLogs Optional output from `terraform plan` / GitHub Actions — errors here take priority.
   */
  async repairMigrateOpsFiles(
    files: Array<{ path: string; content: string }>,
    schemaGuidanceText: string,
    scopeSection: string,
    ciLogs?: string
  ): Promise<Array<{ path: string; content: string }>> {
    const mainTf = files.find((f) => f.path.toLowerCase() === 'main.tf');
    if (!mainTf) return files;

    const paths = files.map((f) => f.path);
    const bundle = files
      .map((f) => `=== FILE: ${f.path} ===\n${f.content}`)
      .join('\n\n');
    const bundleCap = 220_000;
    const bundleTrimmed =
      bundle.length > bundleCap
        ? `${bundle.slice(0, bundleCap)}\n\n... [trimmed]`
        : bundle;

    const ciLogsTrimmed = ciLogs?.trim()
      ? ciLogs.length > 100_000
        ? `${ciLogs.slice(-100_000)}\n\n... [earlier log output truncated]`
        : ciLogs
      : '';
    const ciSection = ciLogsTrimmed
      ? `

--- TERRAFORM CI OUTPUT (GitHub Actions / terraform plan) — fix THESE errors first ---
The following is real output from a failed validate workflow. Address every Error:, unsupported argument, invalid value, and missing attribute mentioned. Line numbers refer to the version of main.tf that was committed when CI ran; match resources and attributes by name.

${ciLogsTrimmed}
--- END CI OUTPUT ---

`
      : '';

    const prompt = `You are a Terraform migration repair specialist. The files below were generated from live Azure resources for import into Terraform state using hashicorp/azurerm ~> 4.x.

Your job: review every resource block in main.tf and fix any attribute names, blocks, or arguments that do not match the azurerm 4.x provider schema. The schema guidance below tells you the correct names.

${scopeSection}

${schemaGuidanceText}
${ciSection}

REPAIR RULES:${ciLogsTrimmed ? '\n0. **PRIORITY:** If CI output appears above, fix every error shown there before applying generic renames. Parse Error: blocks and "Unsupported argument" messages literally.' : ''}
1. If an attribute was renamed in 4.x (e.g. enable_https_traffic_only → https_traffic_only_enabled), replace it with the new name.
2. If a block was removed in 4.x (e.g. encryption {} on storage accounts), remove it and add the correct replacement if one exists.
3. If a required argument is missing (e.g. arm_role_receiver missing "name"), add it with a sensible value derived from context.
4. Deprecated resource types (azurerm_app_service_plan) should be replaced with the current type (azurerm_service_plan) with correct arguments.
5. Computed/read-only attributes (linux_fx_version) should be replaced with the correct writable alternative (application_stack {}).
6. address_prefix (singular) must become address_prefixes = ["..."] (list).
7. Do NOT change resource labels, variable names, or import blocks unless fixing a direct error.
8. Do NOT remove valid attributes that exist in 4.x — only fix wrong ones.
9. Preserve all file content that is already correct.

LOCATION FIDELITY RULES (critical — wrong location forces resource replacement):
10. Every resource block MUST have its location hardcoded from the scanned JSON (e.g. location = "centralus"), NOT var.location or any variable reference. Resources in the same resource group can be in different Azure regions. Replace any \`location = var.location\` or \`location = var.azure_location\` with the actual hardcoded location string from the resource's own JSON \`location\` field. Failure to do this causes forces-replacement in terraform plan.

TAGS (import / plan drift):
10b. Ensure resources that support tags include:
    \`tags = { ManagedBy = "MigrateOps", MigrateOpsImport = "true" }\`.
    Do not fetch or mirror Azure-side tags during CI repair.

AZURERM_CONTAINER_APP SPECIFIC RULES (critical):
11. env blocks inside container {}: use secret_name = "..." NOT secretRef = "...". The argument is secret_name.
12. There is NO probes {} block in azurerm_container_app. Replace any probes {} blocks with separate named blocks:
    - liveness_probe { transport = "HTTP", port = N, path = "/", interval_seconds = 10 }
    - readiness_probe { transport = "HTTP", port = N, path = "/", interval_seconds = 10 }
    - startup_probe { transport = "HTTP", port = N, path = "/", interval_seconds = 10 }
    If the probe type cannot be determined from context, use liveness_probe. If the source probes block has a "type" or similar field, map it.
    PROBE ATTRIBUTE NAMES — only these exact names are accepted by the provider:
      transport, port, path, initial_delay, interval_seconds, timeout,
      failure_count_threshold, success_count_threshold (readiness only), header {}
    WRONG names that will fail terraform plan (never use):
      timeout_seconds, failure_threshold, success_threshold,
      initial_delay_seconds, period_seconds, failure_count, success_count
13. There is NO scale {} block in azurerm_container_app. Move min_replicas and max_replicas OUT of any scale {} block and place them directly inside the template {} block as flat arguments.
14. ingress {} and secret {} are TOP-LEVEL blocks on azurerm_container_app — they must NOT be inside the template {} block.
15. Every ingress {} block in azurerm_container_app MUST contain: target_port (number) and traffic_weight { percentage = 100, latest_revision = true }.
16. Secrets declared in secret {} blocks at the top level must have a name and value. env vars that reference them must use: env { name = "VAR_NAME", secret_name = "secret-name" }.
17. REMOVE the custom_domain {} block from inside ingress {} — it is a computed/read-only exported attribute. Terraform decides it automatically. Also remove fqdn from ingress {} for the same reason.
18. In registry {} blocks: use password_secret_name = "..." NOT password_secret_ref — the provider attribute is password_secret_name (references a top-level secret {} name).
19. In ingress {} only: transport must be lowercase auto, http, http2, or tcp — never "Auto" or "HTTP" (use migrateopsResolvedTerraform.azurerm_container_app.ingress.transport).

--- FILES ---
${bundleTrimmed}

Return JSON: { "files": [ { "path": string, "content": string } ] } with EXACTLY these paths: ${paths.map((p) => JSON.stringify(p)).join(', ')}`;

    try {
      console.log(
        ciLogsTrimmed
          ? '[MigrateOps] Running AI repair pass (CI logs provided)...'
          : '[MigrateOps] Running AI repair pass...'
      );
      const completion = await aiChatCompletion(
        {
          model: MIGRATEOPS_REFINE_MODEL,
          messages: [
            {
              role: 'system',
              content: ciLogsTrimmed
                ? 'You are a Terraform azurerm 4.x schema expert. Failed CI logs are included: fix those terraform plan errors first, then align with provider schema. Output valid JSON only.'
                : 'You are a Terraform azurerm 4.x schema expert. You fix attribute names and blocks to match the current provider registry. Output valid JSON only.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.05,
          max_tokens: MIGRATEOPS_MAX_OUTPUT_TOKENS,
          response_format: { type: 'json_object' },
        },
        { timeout: MIGRATEOPS_AI_TIMEOUT_MS, maxRetries: 1 }
      );

      const response = completion.choices[0]?.message?.content || '{"files":[]}';
      const parsed = JSON.parse(repairJson(response));
      const out = parsed.files;
      if (!Array.isArray(out) || out.length === 0) return files;

      const repairedByPath = new Map<string, string>();
      for (const item of out) {
        if (item?.path && typeof item.content === 'string') {
          repairedByPath.set(item.path, item.content);
        }
      }
      const merged = files.map((f) =>
        repairedByPath.has(f.path) ? { path: f.path, content: repairedByPath.get(f.path)! } : f
      );
      console.log('[MigrateOps] AI repair pass complete.');
      return merged;
    } catch (err: any) {
      console.warn('[MigrateOps] AI repair pass failed, using previous files:', err?.message || err);
      return files;
    }
  }

  /**
   * Terraform module (standalone / aggregated / child): fix HCL after failed local
   * `terraform init -backend=false` + `terraform validate` (same spirit as MigrateOps CI repair).
   */
  async repairTerraformModuleFilesFromValidateOutput(
    files: Array<{ path: string; content: string }>,
    opts: {
      cloudProvider: string | null;
      moduleApproach: string | null;
      failedCheck: TerraformCliValidationResult;
    }
  ): Promise<Array<{ path: string; content: string }>> {
    if (files.length === 0) return files;

    const fc = opts.failedCheck;
    const diagText = fc.diagnostics
      .map(
        (d) =>
          `[${d.severity || 'error'}] ${d.summary || ''}${d.detail ? `\n${d.detail}` : ''}${d.range?.filename ? `\nfile: ${d.range.filename}` : ''}`
      )
      .join('\n---\n');

    const initSection =
      fc.initOk || (!fc.initStderr && !fc.initStdout)
        ? ''
        : `\n--- terraform init (-backend=false) output ---\n${(fc.initStderr || '').slice(0, 12000)}${(fc.initStdout || '').slice(0, 4000)}\n--- end init ---\n`;

    const validateSection = fc.validateRaw
      ? `\n--- terraform validate -json (excerpt) ---\n${fc.validateRaw.slice(0, 14000)}\n--- end validate ---\n`
      : '';

    const paths = files.map((f) => f.path);
    const bundle = files
      .map((f) => `=== FILE: ${f.path} ===\n${f.content}`)
      .join('\n\n');
    const bundleCap = 200_000;
    const bundleTrimmed =
      bundle.length > bundleCap ? `${bundle.slice(0, bundleCap)}\n\n... [bundle trimmed]` : bundle;

    const approachRules =
      opts.moduleApproach === 'standalone-root'
        ? `Standalone ROOT module: main.tf must use resource/data blocks for the cloud provider. Do NOT use module blocks with remote sources (https://, git::, Azure Blob, .zip). Provider/terraform blocks live in separate files — do not duplicate them in main.tf.`
        : opts.moduleApproach === 'aggregated-root'
          ? `Aggregated ROOT: root main.tf uses module { source = "./ChildDir" } to compose local child modules; fix paths and variables to match.`
          : opts.moduleApproach === 'child-module'
            ? `Child module: only resource blocks in module folders; no root provider/terraform blocks in child main.tf files.`
            : '';

    const cloud =
      opts.cloudProvider === 'azure'
        ? 'hashicorp/azurerm ~> 4.x'
        : opts.cloudProvider === 'aws'
          ? 'hashicorp/aws'
          : opts.cloudProvider === 'gcp'
            ? 'hashicorp/google'
            : 'the selected cloud provider';

    const prompt = `You are a senior Terraform engineer. The following Terraform files failed \`terraform init -backend=false\` and/or \`terraform validate\` in automation.

Cloud / provider target: ${cloud}
Module approach: ${opts.moduleApproach || 'unspecified'}
${approachRules}

DIAGNOSTICS (fix every issue referenced; unsupported arguments, missing required arguments, type errors, undeclared variables, invalid references):
${diagText || '(no structured diagnostics)'}
${initSection}
${validateSection}

FULL FILE SET (return corrected content for each path):
${bundleTrimmed}

RULES:
1. Return JSON only: { "files": [ { "path": string, "content": string } ] }.
2. Include EVERY path exactly once: ${paths.map((p) => JSON.stringify(p)).join(', ')}.
3. Preserve working code; change only what is needed for validate to pass.
4. Ensure variables.tf declares every var.* used; dev.terraform.tfvars supplies values where needed.
5. For Azure, use argument names compatible with azurerm 4.x registry docs.

`;

    try {
      console.log('[Terraform module] Running AI CLI repair pass...');
      const completion = await aiChatCompletion(
        {
          model: TERRAFORM_MODULE_CLI_REPAIR_MODEL,
          messages: [
            {
              role: 'system',
              content:
                'You fix Terraform HCL so terraform validate passes. Output valid JSON with a "files" array only.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.06,
          max_tokens: TERRAFORM_MODULE_CLI_REPAIR_MAX_TOKENS,
          response_format: { type: 'json_object' },
        },
        { timeout: TERRAFORM_MODULE_CLI_REPAIR_TIMEOUT_MS, maxRetries: 1 }
      );

      const response = completion.choices[0]?.message?.content || '{"files":[]}';
      const parsed = JSON.parse(repairJson(response));
      const out = parsed.files;
      if (!Array.isArray(out) || out.length === 0) return files;

      const repairedByPath = new Map<string, string>();
      for (const item of out) {
        if (item?.path && typeof item.content === 'string') {
          repairedByPath.set(item.path, item.content);
        }
      }
      const merged = files.map((f) =>
        repairedByPath.has(f.path) ? { path: f.path, content: repairedByPath.get(f.path)! } : f
      );
      console.log('[Terraform module] AI CLI repair pass complete.');
      return merged;
    } catch (err: unknown) {
      console.warn('[Terraform module] AI CLI repair failed, keeping previous files:', err);
      return files;
    }
  }

  /**
   * Terraform module: repair using real GitHub Actions `terraform plan` / validate job logs
   * (same role as MigrateOps repair-from-logs).
   */
  async repairTerraformModuleFromCiPlanLogs(
    files: Array<{ path: string; content: string }>,
    opts: {
      cloudProvider: string | null;
      moduleApproach: string | null;
      planLogs: string;
    }
  ): Promise<Array<{ path: string; content: string }>> {
    if (files.length === 0) return files;

    const planLogsTrimmed = opts.planLogs.trim()
      ? opts.planLogs.length > 100_000
        ? `... [truncated]\n${opts.planLogs.slice(-100_000)}`
        : opts.planLogs
      : '';

    if (!planLogsTrimmed) return files;

    const paths = files.map((f) => f.path);
    const bundle = files
      .map((f) => `=== FILE: ${f.path} ===\n${f.content}`)
      .join('\n\n');
    const bundleCap = 200_000;
    const bundleTrimmed =
      bundle.length > bundleCap ? `${bundle.slice(0, bundleCap)}\n\n... [bundle trimmed]` : bundle;

    const approachRules =
      opts.moduleApproach === 'standalone-root'
        ? `Standalone ROOT module: main.tf uses resource/data blocks; no remote module package sources (https/git/blob zip). Provider/terraform blocks stay in their own files.`
        : opts.moduleApproach === 'aggregated-root'
          ? `Aggregated ROOT: root main.tf composes local modules via module { source = "./Dir" }.`
          : opts.moduleApproach === 'child-module'
            ? `Child modules: resource blocks only in folder main.tf files.`
            : '';

    const cloud =
      opts.cloudProvider === 'azure'
        ? 'hashicorp/azurerm ~> 4.x'
        : opts.cloudProvider === 'aws'
          ? 'hashicorp/aws'
          : opts.cloudProvider === 'gcp'
            ? 'hashicorp/google'
            : 'the selected cloud provider';

    const prompt = `You are a senior Terraform engineer. GitHub Actions ran terraform init/plan/validate and FAILED. Fix the Terraform files so a subsequent plan can succeed.

Cloud / provider: ${cloud}
Module approach: ${opts.moduleApproach || 'unspecified'}
${approachRules}

--- TERRAFORM CI OUTPUT (GitHub Actions) — fix every error below first ---
Address Error:, unsupported argument, missing required argument, invalid reference, provider errors, and variable/tfvars issues mentioned in the logs.

${planLogsTrimmed}
--- END CI OUTPUT ---

FULL FILE SET (return corrected content for each path):
${bundleTrimmed}

RULES:
1. Return JSON only: { "files": [ { "path": string, "content": string } ] }.
2. Include EVERY path exactly once: ${paths.map((p) => JSON.stringify(p)).join(', ')}.
3. Preserve correct code; change only what CI errors require.
4. variables.tf / dev.terraform.tfvars must align with var.* usage in .tf files.
5. For Azure, use azurerm 4.x documented argument names.

`;

    try {
      console.log('[Terraform module] Running AI repair from CI plan logs...');
      const completion = await aiChatCompletion(
        {
          model: TERRAFORM_MODULE_CLI_REPAIR_MODEL,
          messages: [
            {
              role: 'system',
              content:
                'You fix Terraform HCL using failed CI terraform plan/validate logs. Output valid JSON with a "files" array only.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.06,
          max_tokens: TERRAFORM_MODULE_CLI_REPAIR_MAX_TOKENS,
          response_format: { type: 'json_object' },
        },
        { timeout: TERRAFORM_MODULE_CLI_REPAIR_TIMEOUT_MS, maxRetries: 1 }
      );

      const response = completion.choices[0]?.message?.content || '{"files":[]}';
      const parsed = JSON.parse(repairJson(response));
      const out = parsed.files;
      if (!Array.isArray(out) || out.length === 0) return files;

      const repairedByPath = new Map<string, string>();
      for (const item of out) {
        if (item?.path && typeof item.content === 'string') {
          repairedByPath.set(item.path, item.content);
        }
      }
      const merged = files.map((f) =>
        repairedByPath.has(f.path) ? { path: f.path, content: repairedByPath.get(f.path)! } : f
      );
      console.log('[Terraform module] AI repair from CI logs complete.');
      return merged;
    } catch (err: unknown) {
      console.warn('[Terraform module] AI repair from CI logs failed:', err);
      return files;
    }
  }

  /**
   * Plain-language drift explanation + fix steps for MigrateOps sync-check (UI).
   * Set MIGRATEOPS_SYNC_AI=0 to skip (details lists still returned).
   */
  async generateMigrateSyncRemediation(payload: {
    missingImports: string[];
    staleImports: Array<{ to: string; id: string }>;
    orphanImports: string[];
    terraformResourceCount: number;
    importBlockCount: number;
  }): Promise<{
    summary: string;
    suggestions: Array<{
      category: 'missing_import' | 'stale_import_id' | 'orphan_import';
      title: string;
      detail: string;
      suggestedFix: string;
    }>;
  } | null> {
    if (
      payload.missingImports.length === 0 &&
      payload.staleImports.length === 0 &&
      payload.orphanImports.length === 0
    ) {
      return null;
    }

    const prompt = `MigrateOps sync check found drift between Terraform resources in main.tf, import blocks in imports.tf, and the last scanned Azure resource list.

DATA:
${JSON.stringify(payload, null, 2)}

MEANINGS:
- missingImports: addresses that appear as resource blocks in Terraform but have no matching import { to = ... } — imports are needed for state alignment when adopting existing Azure resources.
- staleImports: import id values that do not match any resource ID from the scanned Azure inventory (subscription may have changed or scan is stale).
- orphanImports: import "to" addresses that do not match any resource block in the current Terraform root module.

Return JSON only:
{
  "summary": "2-5 sentences in plain English for someone doing a migration",
  "suggestions": [
    {
      "category": "missing_import" | "stale_import_id" | "orphan_import",
      "title": "short headline",
      "detail": "what is wrong",
      "suggestedFix": "concrete remediation steps (which file to edit, whether to re-run Extract, etc.)"
    }
  ]
}
At most 12 suggestions; group similar resource addresses into one suggestion when helpful.`;

    try {
      const completion = await aiChatCompletion(
        {
          model: process.env.MIGRATEOPS_SYNC_AI_MODEL || 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content:
                'You are a Terraform migration expert. Respond with valid JSON only. Be specific and actionable.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.15,
          max_tokens: 2500,
          response_format: { type: 'json_object' },
        },
        { timeout: 90000, maxRetries: 1 }
      );
      const raw = completion.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(repairJson(raw));
      if (!parsed.summary || !Array.isArray(parsed.suggestions)) return null;
      const allowed = new Set(['missing_import', 'stale_import_id', 'orphan_import']);
      return {
        summary: String(parsed.summary),
        suggestions: parsed.suggestions.map((s: any) => ({
          category: allowed.has(s.category) ? s.category : 'missing_import',
          title: String(s.title || 'Issue'),
          detail: String(s.detail || ''),
          suggestedFix: String(s.suggestedFix || ''),
        })),
      };
    } catch (e: any) {
      console.warn('generateMigrateSyncRemediation failed:', e?.message || e);
      return null;
    }
  }

  /**
   * Generate automation script based on language and user prompt
   */
  async generateAutomation(
    language: 'python' | 'powershell' | 'shell' | 'bash',
    prompt: string
  ): Promise<{
    files: Array<{ path: string; content: string }>;
  }> {
    console.log('\n🔍 ========== AUTOMATION SCRIPT GENERATION ==========');
    console.log(`📝 User Prompt: "${prompt}"`);
    console.log(`💻 Language: ${language}`);
    console.log('\n🤖 Generating automation script...');

    const languageInfo = {
      python: {
        extension: '.py',
        name: 'Python',
        comment: '#',
        shebang: '#!/usr/bin/env python3',
        bestPractices: 'Use type hints, docstrings, error handling, and follow PEP 8 style guide.'
      },
      powershell: {
        extension: '.ps1',
        name: 'PowerShell',
        comment: '#',
        shebang: '',
        bestPractices: 'Use proper error handling with try-catch, parameter validation, and follow PowerShell best practices.'
      },
      shell: {
        extension: '.sh',
        name: 'Shell',
        comment: '#',
        shebang: '#!/bin/sh',
        bestPractices: 'Use proper error handling with set -e, validate inputs, and follow POSIX shell standards.'
      },
      bash: {
        extension: '.sh',
        name: 'Bash',
        comment: '#',
        shebang: '#!/bin/bash',
        bestPractices: 'Use proper error handling with set -euo pipefail, validate inputs, and follow bash best practices.'
      }
    };

    const lang = languageInfo[language];
    const fileName = `automation${lang.extension}`;

    const systemPrompt = `You are an expert ${lang.name} automation script developer. Generate production-ready automation scripts that are:
- Well-documented with clear comments
- Include proper error handling
- Follow ${lang.name} best practices: ${lang.bestPractices}
- Are secure and follow security best practices
- Include usage instructions in comments
- Are ready to be deployed to CI/CD pipelines

Generate ONLY the script code, no markdown, no explanations outside of code comments.`;

    const userPrompt = `Generate a ${lang.name} automation script for the following task:

${prompt}

Requirements:
1. Include a ${lang.shebang ? 'shebang line' : 'proper header'} at the top
2. Add clear comments explaining what the script does
3. Include proper error handling
4. Make the script production-ready and secure
5. Follow ${lang.name} best practices
6. Include usage instructions in comments if applicable

Generate the complete script code.`;

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 4000,
      });

      let scriptContent = completion.choices[0]?.message?.content?.trim() || '';

      // Clean up the response (remove markdown code blocks if present)
      scriptContent = scriptContent.replace(/^```[\w]*\n?/gm, '').replace(/\n?```$/gm, '').trim();

      // Ensure shebang is present if needed
      if (lang.shebang && !scriptContent.startsWith('#!')) {
        scriptContent = `${lang.shebang}\n\n${scriptContent}`;
      }

      console.log(`   ✅ Generated ${lang.name} script: ${fileName}`);
      console.log(`   📏 Script length: ${scriptContent.length} characters`);
      console.log('==========================================\n');

      return {
        files: [
          {
            path: fileName,
            content: scriptContent
          }
        ]
      };
    } catch (error: any) {
      console.error('❌ Automation generation failed:', error);
      throw new Error(`Failed to generate automation script: ${error.message || 'Unknown error'}`);
    }
  }
}

export const openaiService = new OpenAIService();
