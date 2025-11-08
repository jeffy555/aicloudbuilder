import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class OpenAIService {
  private systemPrompt = `You are an AI DevOps assistant helping users create and manage Terraform configurations. 

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

  async chat(messages: ChatMessage[]): Promise<string> {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: this.systemPrompt },
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

  async generateTerraform(
    description: string, 
    cloudProvider: string | null, 
    moduleApproach: string | null
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

This is a STANDALONE ROOT MODULE. Generate a complete, self-contained configuration that:
- Defines all resources needed for this infrastructure using "resource" blocks
- Includes provider configuration
- Uses variables for customization
- Is ready to be applied directly with terraform apply

Please provide files:
1. main.tf - Provider configuration and resource definitions
2. variables.tf - Variable declarations
3. terraform.tfvars - Variable values

Format your response as JSON with a "files" array. Each file has "path" and "content" keys.`;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a Terraform expert. Generate well-structured, production-ready standalone root modules with provider configuration and resource definitions.' },
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
    } else if (moduleApproach === 'aggregated-root') {
      // Aggregated root modules use module blocks to call child modules
      const prompt = `Generate Terraform aggregated root module for ${cloudName} based on this description: "${description}"

This is an AGGREGATED ROOT MODULE. Generate a root module that:
- Uses "module" blocks to call child modules (assume they exist in subfolders)
- Includes provider configuration
- Passes variables to child modules
- Aggregates outputs from child modules
- Coordinates the overall infrastructure

Please provide files:
1. main.tf - Provider configuration and module calls
2. variables.tf - Variable declarations
3. terraform.tfvars - Variable values

Format your response as JSON with a "files" array. Each file has "path" and "content" keys.`;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a Terraform expert. Generate well-structured aggregated root modules that orchestrate multiple child modules using module blocks.' },
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
