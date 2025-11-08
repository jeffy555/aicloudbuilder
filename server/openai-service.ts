import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
- Create main.tf, variables.tf, and terraform.tfvars files
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

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ],
      temperature: 0.7,
      max_tokens: 2000,
    });

    return completion.choices[0]?.message?.content || '';
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

  private generateBackendTf(backendConfig: {
    backendType?: string;
    storageAccount?: string;
    resourceGroup?: string;
    container?: string;
    stateKey?: string;
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
    }
    return '';
  }

  private generateProviderTf(cloudProvider: string): string {
    if (cloudProvider === 'azure') {
      return `terraform {
  required_version = ">= 1.0"
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
    }
  ): Promise<{
    files: Array<{ path: string; content: string }>;
  }> {
    const cloudName = cloudProvider === 'azure' ? 'Microsoft Azure' : 
                     cloudProvider === 'aws' ? 'Amazon Web Services (AWS)' : 
                     cloudProvider === 'gcp' ? 'Google Cloud Platform (GCP)' : 
                     'the specified cloud provider';
    
    if (moduleApproach === 'child-module') {
      // Child modules use folder-based organization
      const prompt = `Generate Terraform child module code for ${cloudName} based on this description: "${description}"

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
- Do NOT include terraform.tfvars (that's for root modules only)

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

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a Terraform expert specializing in reusable child modules. Generate well-structured child modules using ONLY resource blocks, organized by resource type into separate folders. Never use module blocks in child modules.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 4000,
        response_format: { type: 'json_object' }
      });

      const response = completion.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(response);
      
      return {
        files: parsed.files || []
      };
    } else if (moduleApproach === 'standalone-root') {
      // Standalone root modules use flat structure
      const prompt = `Generate Terraform standalone root module for ${cloudName} based on this description: "${description}"

This is a STANDALONE ROOT MODULE. Generate concise, production-ready configuration with sensible defaults:
- Use opinionated resource names (don't ask user for names, generate appropriate ones)
- Infer reasonable configurations from the description
- Define all resources using "resource" blocks
- Create variables ONLY for values that truly need customization (regions, sizes, not names)
- Use consistent naming patterns (e.g., "my-resource-group", "my-storage-account")

CRITICAL: DO NOT include provider configuration or terraform blocks in main.tf - those will be in separate files.

Please provide files:
1. main.tf - Resource definitions ONLY (no provider blocks, no terraform blocks)
2. variables.tf - Variable declarations (minimal, only for customizable values)
3. terraform.tfvars - Variable values with sensible defaults
4. outputs.tf - Outputs for important resource attributes (optional but recommended)

Format your response as JSON with a "files" array. Each file has "path" and "content" keys.`;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a Terraform expert. Generate concise, production-ready configurations with opinionated defaults. Avoid over-parameterization. Generate sensible resource names without prompting the user.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 4000,
        response_format: { type: 'json_object' }
      });

      const response = completion.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(response);
      
      // Add backend.tf and provider.tf for root modules
      const allFiles = [...(parsed.files || [])];
      
      if (cloudProvider) {
        allFiles.unshift({
          path: 'provider.tf',
          content: this.generateProviderTf(cloudProvider)
        });
      }
      
      if (backendConfig?.hasBackend && backendConfig.backendType) {
        allFiles.unshift({
          path: 'backend.tf',
          content: this.generateBackendTf(backendConfig)
        });
      }
      
      return {
        files: allFiles
      };
    } else if (moduleApproach === 'aggregated-root') {
      // Aggregated root modules use module blocks to call child modules
      const prompt = `Generate Terraform aggregated root module for ${cloudName} based on this description: "${description}"

This is an AGGREGATED ROOT MODULE. Generate concise configuration with opinionated defaults:
- Use "module" blocks to call child modules (assume they exist in subfolders)
- Use sensible module names and paths
- Pass variables to child modules with reasonable defaults
- Aggregate outputs from child modules
- Minimal parameterization - only variables that truly need customization

CRITICAL: DO NOT include provider configuration or terraform blocks in main.tf - those will be in separate files.

Please provide files:
1. main.tf - Module calls ONLY (no provider blocks, no terraform blocks)
2. variables.tf - Variable declarations (minimal)
3. terraform.tfvars - Variable values with sensible defaults
4. outputs.tf - Aggregated outputs from child modules

Format your response as JSON with a "files" array. Each file has "path" and "content" keys.`;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a Terraform expert. Generate concise aggregated root modules with opinionated defaults. Avoid asking users for every detail.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 4000,
        response_format: { type: 'json_object' }
      });

      const response = completion.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(response);
      
      // Add backend.tf and provider.tf for root modules
      const allFiles = [...(parsed.files || [])];
      
      if (cloudProvider) {
        allFiles.unshift({
          path: 'provider.tf',
          content: this.generateProviderTf(cloudProvider)
        });
      }
      
      if (backendConfig?.hasBackend && backendConfig.backendType) {
        allFiles.unshift({
          path: 'backend.tf',
          content: this.generateBackendTf(backendConfig)
        });
      }
      
      return {
        files: allFiles
      };
    } else {
      // Default fallback
      const prompt = `Generate Terraform configuration files for ${cloudName} based on this description: "${description}"

Please provide files:
1. main.tf - Resource definitions
2. variables.tf - Variable declarations
3. terraform.tfvars - Variable values

Format your response as JSON with a "files" array. Each file has "path" and "content" keys.`;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a Terraform expert. Generate well-structured, production-ready Terraform code.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 4000,
        response_format: { type: 'json_object' }
      });

      const response = completion.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(response);
      
      return {
        files: parsed.files || []
      };
    }
  }

  async generateCommitMessage(files: { name: string; content: string }[]): Promise<string> {
    const filesDescription = files.map(f => `${f.name}`).join(', ');
    
    const prompt = `Generate a concise git commit message for these Terraform files: ${filesDescription}

Analyze the content and create a descriptive commit message that explains what infrastructure resources are being added or modified. Keep it under 100 characters.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: prompt }
      ],
      temperature: 0.5,
      max_tokens: 100,
    });

    return completion.choices[0]?.message?.content?.trim() || 'Add Terraform configuration';
  }
}

export const openaiService = new OpenAIService();
