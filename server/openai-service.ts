import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
        model: 'gpt-4.1',
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
      model: 'gpt-4.1',
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
      version = "~> 3.0"
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
        model: 'gpt-4.1',
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
        model: 'gpt-4.1',
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
        model: 'gpt-4.1',
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
        model: 'gpt-4.1',
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
    // Step 1: OpenAI analyzes the request first
    console.log('\n🔍 ========== TERRAFORM GENERATION FLOW ==========');
    console.log(`📝 User Description: "${description}"`);
    console.log(`☁️  Cloud Provider: ${cloudProvider || 'Not specified'}`);
    console.log(`📦 Module Approach: ${moduleApproach || 'Not specified'}`);
    console.log('\n🤖 Step 1: AI analyzing user request...');
    
    // Use OpenAI to analyze and refine the request
    const analysisPrompt = `You are a Terraform expert. Analyze the following user request and prepare it for the Terraform MCP server.

User Request: "${description}"
Cloud Provider: ${cloudProvider || 'Not specified'}
Module Approach: ${moduleApproach || 'Not specified'}

Your task:
1. Identify all resources the user wants to create
2. Refine the description to be clear and specific for Terraform code generation
3. Ensure the description includes all necessary details for the Terraform MCP server

Return a JSON object with:
{
  "refinedDescription": "A clear, detailed description optimized for Terraform MCP server",
  "resources": ["list of resource types identified"],
  "recommendations": "Any additional recommendations or clarifications"
}

Be specific about resource types (e.g., "azurerm_resource_group", "azurerm_storage_account", "azurerm_container_registry").`;

    let refinedDescription = description;
    let analysis: any = null;
    
    try {
      const analysisCompletion = await openai.chat.completions.create({
        model: 'gpt-4.1',
        messages: [
          { 
            role: 'system', 
            content: 'You are a Terraform expert. Analyze user requests and prepare them for Terraform code generation. Return only valid JSON.' 
          },
          { role: 'user', content: analysisPrompt }
        ],
        temperature: 0.3,
        max_tokens: 500,
        response_format: { type: 'json_object' }
      });

      const analysisResponse = analysisCompletion.choices[0]?.message?.content || '{}';
      analysis = JSON.parse(analysisResponse);
      
      if (analysis.refinedDescription) {
        refinedDescription = analysis.refinedDescription;
        console.log(`   ✅ AI Analysis Complete`);
        console.log(`   📋 Identified Resources: ${analysis.resources?.join(', ') || 'N/A'}`);
        console.log(`   ✨ Refined Description: "${refinedDescription.substring(0, 150)}${refinedDescription.length > 150 ? '...' : ''}"`);
        if (analysis.recommendations) {
          console.log(`   💡 Recommendations: ${analysis.recommendations}`);
        }
      } else {
        console.log(`   ⚠️  AI analysis didn't return refined description, using original`);
      }
    } catch (analysisError: any) {
      console.error(`   ⚠️  AI analysis failed: ${analysisError?.message || analysisError}`);
      console.log(`   Using original description`);
      // Continue with original description
    }

    // Step 2: Fetch latest Terraform documentation from MCP server
    console.log('\n🔗 Step 2: Fetching latest Terraform documentation from MCP server...');
    
    let terraformDocs = '';
    let resourcesToFetch: string[] = [];
    
    // Extract resources from AI analysis if available
    if (analysis && analysis.resources && Array.isArray(analysis.resources)) {
      resourcesToFetch = analysis.resources;
    } else {
      // Fallback: try to extract from description
      const resourcePatterns = [
        /azurerm_(\w+)/gi,
        /aws_(\w+)/gi,
        /google_(\w+)/gi,
        /(\w+)\s+(storage|compute|network|container|registry|account|group|service|function|app)/gi
      ];
      
      for (const pattern of resourcePatterns) {
        let match;
        while ((match = pattern.exec(refinedDescription)) !== null) {
          if (match[1] && !resourcesToFetch.includes(match[1])) {
            resourcesToFetch.push(match[1]);
          }
        }
      }
    }
    
    if (resourcesToFetch.length > 0) {
      try {
        const { mcpClient } = await import('./mcp-client');
        terraformDocs = await mcpClient.fetchTerraformDocumentation(resourcesToFetch, cloudProvider);
        console.log(`\n✅ SUCCESS: Fetched Terraform documentation for ${resourcesToFetch.length} resource(s)`);
        console.log(`📚 Documentation length: ${terraformDocs.length} characters`);
        console.log('==========================================\n');
      } catch (mcpError: any) {
        console.error(`\n❌ FAILED: Terraform MCP server error: ${mcpError?.message || mcpError}`);
        console.error('⚠️  Continuing without MCP documentation - will use OpenAI with general knowledge...');
        console.log('==========================================\n');
        // Continue without docs - OpenAI will use its training data
      }
    } else {
      console.log(`   ⚠️  No specific resources identified, skipping MCP documentation fetch`);
    }
    // Step 3: Generate Terraform code using OpenAI with MCP documentation
    console.log('\n🤖 Step 3: Generating Terraform code with OpenAI...');
    if (terraformDocs) {
      console.log(`   📚 Using latest documentation from Terraform MCP server`);
    } else {
      console.log(`   ⚠️  Using OpenAI's training data (no MCP docs available)`);
    }
    
    const cloudName = cloudProvider === 'azure' ? 'Microsoft Azure' : 
                     cloudProvider === 'aws' ? 'Amazon Web Services (AWS)' : 
                     cloudProvider === 'gcp' ? 'Google Cloud Platform (GCP)' : 
                     'the specified cloud provider';
    
    // Build enhanced prompt with MCP documentation
    const docsContext = terraformDocs 
      ? `\n\nLATEST TERRAFORM DOCUMENTATION FROM OFFICIAL SOURCES:\n${terraformDocs}\n\nUse this documentation to ensure your code follows the latest Terraform patterns and best practices.`
      : '';
    
    if (moduleApproach === 'child-module') {
      // Child modules use folder-based organization
      const prompt = `Generate Terraform child module code for ${cloudName} based on this description: "${refinedDescription}"${docsContext}

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
        model: 'gpt-4.1',
        messages: [
          { role: 'system', content: 'You are a Terraform expert specializing in reusable child modules. Generate well-structured child modules using ONLY resource blocks, organized by resource type into separate folders. Never use module blocks in child modules.' },
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
        model: 'gpt-4.1',
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
                : `You are a Terraform expert specializing in production-ready, best-practice Terraform code. Generate code that follows ALL Terraform best practices and industry standards.

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
   - Avoid duplication - use variables, locals, or modules
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
        model: 'gpt-4.1',
        messages: [
          { role: 'system', content: 'You are a Terraform expert. Generate concise aggregated root modules with opinionated defaults. Avoid asking users for every detail.' },
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
        model: 'gpt-4.1',
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
      model: 'gpt-4.1',
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
      model: 'gpt-4.1',
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
      model: 'gpt-4.1',
      messages: [
        { role: 'system', content: 'You are a Terraform expert. Generate sensible default values for .tfvars files based on context.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content?.trim() || '';
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
        model: 'gpt-4.1',
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
        model: 'gpt-4.1',
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
