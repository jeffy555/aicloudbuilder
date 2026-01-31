/**
 * Code Generator for ArchMe Components
 * 
 * Generates infrastructure code (Terraform, ARM, Helm, YAML) for each component
 */

import OpenAI from 'openai';
import type { ExtractedComponent } from './component-extractor';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface GeneratedCode {
  componentName: string;
  codeType: 'terraform' | 'arm' | 'helm' | 'yaml' | 'kubernetes';
  fileName: string;
  content: string;
  description: string;
  dependencies: string[];
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
8. For ARM templates: Include complete JSON template structure
9. For Helm: Include values.yaml and Chart.yaml
10. For YAML/Kubernetes: Include complete manifests
11. For Kubernetes: Include all necessary resources (Deployment, Service, ConfigMap, etc.)`;

  const userPrompt = `Generate ${component.codeType} code for:

COMPONENT: ${component.name}
TYPE: ${component.type}
PROVIDER: ${component.provider}
CATEGORY: ${component.category}
DESCRIPTION: ${component.description}
${component.metadata?.serviceType ? `SERVICE TYPE: ${component.metadata.serviceType}` : ''}

DEPENDENCIES: ${dependencyInfo || 'None'}

REPOSITORY TYPE: ${repositoryType}

Generate complete, production-ready ${component.codeType} code for this component.`;

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

    let code = completion.choices[0]?.message?.content?.trim() || '';
    
    // Remove markdown code blocks if present
    code = code
      .replace(/^```(?:terraform|hcl|json|yaml|yml)?\n?/i, '')
      .replace(/^```\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim();

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
      return `values.yaml`; // Helm charts have specific structure
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
  
  const results: GeneratedCode[] = [];
  
  // Generate code for each component sequentially (to avoid rate limits)
  for (const component of components) {
    try {
      const code = await generateComponentCode(component, components, repositoryType);
      results.push(code);
      
      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error: any) {
      console.error(`   ❌ Failed for ${component.name}: ${error.message}`);
      // Continue with other components even if one fails
    }
  }
  
  console.log(`\n✅ Generated code for ${results.length}/${components.length} components`);
  return results;
}

