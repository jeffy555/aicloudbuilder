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
    mainTf: string;
    variablesTf: string;
    tfvars: string;
  }> {
    const cloudName = cloudProvider === 'azure' ? 'Microsoft Azure' : 
                     cloudProvider === 'aws' ? 'Amazon Web Services (AWS)' : 
                     cloudProvider === 'gcp' ? 'Google Cloud Platform (GCP)' : 
                     'the specified cloud provider';
    
    const moduleContext = moduleApproach === 'child-module' 
      ? `This is a CHILD MODULE. Generate reusable module code that:
- Accepts input variables for flexibility
- Creates specific resources
- Outputs important values for parent modules to use
- Follows module best practices (no provider configuration in the module)
- Can be called multiple times with different values`
      : moduleApproach === 'standalone-root'
      ? `This is a STANDALONE ROOT MODULE. Generate a complete, self-contained configuration that:
- Defines all resources needed for this infrastructure
- Includes provider configuration
- Uses variables for customization
- Is ready to be applied directly`
      : moduleApproach === 'aggregated-root'
      ? `This is an AGGREGATED ROOT MODULE. Generate a root module that:
- Calls multiple child modules (you can assume they exist)
- Includes provider configuration
- Passes variables to child modules
- Aggregates outputs from child modules
- Coordinates the overall infrastructure`
      : 'Generate a Terraform configuration';

    const prompt = `Generate Terraform configuration files for ${cloudName} based on this description: "${description}"

MODULE APPROACH: ${moduleContext}

Please provide three files:
1. main.tf - Main resource definitions (or module calls for aggregated root)
2. variables.tf - Variable declarations
3. terraform.tfvars - Variable values

Format your response as JSON with keys: mainTf, variablesTf, tfvars
Each value should be the complete file content.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a Terraform expert. Generate well-structured, production-ready Terraform code following best practices for the specified module approach.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 3000,
      response_format: { type: 'json_object' }
    });

    const response = completion.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(response);

    return {
      mainTf: parsed.mainTf || '',
      variablesTf: parsed.variablesTf || '',
      tfvars: parsed.tfvars || '',
    };
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
