/**
 * AI-Assisted Template Generator
 * 
 * Generates remediation templates using AI + RAG
 * Can be used manually or in bulk
 */

import { OpenAIService } from '../openai-service';
import { queryVectorStore } from '../rag/vector-store';
import { RemediationRAGService } from '../rag/remediation-rag';
import yaml from 'js-yaml';
import fs from 'fs/promises';
import path from 'path';

const openaiService = new OpenAIService();
const remediationRAGService = new RemediationRAGService();

interface CheckovCheckInfo {
  checkId: string;
  checkName: string;
  guideline: string;
  resourceType: string;
}

interface GeneratedTemplate {
  template: any;
  confidence: number;
  needsReview: boolean;
  errors?: string[];
}

/**
 * Fetch Checkov guideline (placeholder - would need to fetch from Checkov Policy Index)
 */
async function fetchCheckovGuideline(checkId: string): Promise<string> {
  // TODO: Implement actual Checkov Policy Index fetching
  // For now, return placeholder
  return `Ensure that ${checkId} security requirement is met.`;
}

/**
 * Generate template using AI
 */
async function generateTemplate(
  checkInfo: CheckovCheckInfo
): Promise<GeneratedTemplate> {
  try {
    // 1. Fetch Checkov guideline
    const guideline = checkInfo.guideline || await fetchCheckovGuideline(checkInfo.checkId);
    
    // 2. Query Terraform docs from vector DB
    const terraformDocs = await queryVectorStore({
      query: `${checkInfo.resourceType} ${checkInfo.checkId} ${guideline}`,
      topK: 3,
    });
    
    // 3. Get similar templates for reference
    const similarTemplates = await remediationRAGService.findRemediation(
      checkInfo.checkId,
      checkInfo.checkName,
      guideline,
      checkInfo.resourceType
    );
    
    // 4. Build AI prompt
    const prompt = `You are a Terraform security expert. Generate a remediation template for Checkov check ${checkInfo.checkId}.

CHECKOV CHECK:
- ID: ${checkInfo.checkId}
- Name: ${checkInfo.checkName}
- Guideline: ${guideline}
- Resource Type: ${checkInfo.resourceType}

TERRAFORM DOCUMENTATION:
${terraformDocs.map((doc: any) => doc.metadata?.content || '').join('\n\n')}

${similarTemplates ? `SIMILAR TEMPLATE (for reference):
Check ID: ${similarTemplates.template.check_id}
Remediation: ${similarTemplates.template.remediation_snippet}
` : ''}

Generate a complete YAML template with the following structure:

\`\`\`yaml
check_id: ${checkInfo.checkId}
check_name: "${checkInfo.checkName}"
resource_types:
  - ${checkInfo.resourceType}
terraform_attribute: <exact Terraform attribute name>
attribute_type: simple | block | nested_block
required_value: <the value that satisfies the check>
description: <clear description of what this check does>
remediation_snippet: |
  <the exact code snippet to add/modify>
complete_example: |
  resource "${checkInfo.resourceType}" "example" {
    name                = "example"
    resource_group_name = azurerm_resource_group.example.name
    location            = azurerm_resource_group.example.location
    <remediation_snippet here>
  }
tags:
  - <relevant tag 1>
  - <relevant tag 2>
keywords:
  - <keyword 1>
  - <keyword 2>
confidence_factors:
  exact_match: false
  tested: false
  documentation_url: <link to Terraform provider docs>
\`\`\`

CRITICAL REQUIREMENTS:
1. The terraform_attribute must be the EXACT attribute name from Terraform provider documentation
2. The remediation_snippet must be valid Terraform code
3. The complete_example must include the remediation_snippet
4. The required_value must be the correct value that satisfies the Checkov check
5. Use appropriate tags and keywords for searchability

Return ONLY the YAML content, nothing else.`;

    // 5. Generate template using AI
    const aiResponse = await openaiService.chat([
      {
        role: 'system',
        content: 'You are a Terraform security expert. Generate accurate remediation templates for Checkov security checks. Return only valid YAML.'
      },
      {
        role: 'user',
        content: prompt
      }
    ]);
    
    // 6. Extract YAML from response
    let yamlContent = aiResponse.trim();
    if (yamlContent.includes('```yaml')) {
      yamlContent = yamlContent.replace(/```yaml\s*\n/, '').replace(/\n```\s*$/, '');
    } else if (yamlContent.includes('```')) {
      yamlContent = yamlContent.replace(/```\s*\n/, '').replace(/\n```\s*$/, '');
    }
    
    // 7. Parse and validate
    const template = yaml.load(yamlContent) as any;
    
    // 8. Validate template
    const validation = validateTemplate(template);
    
    // 9. Calculate confidence
    let confidence = 0.8; // Base confidence
    if (validation.isValid) {
      confidence = 0.9;
    } else {
      confidence = Math.max(0.5, 0.9 - (validation.errors.length * 0.1));
    }
    
    return {
      template,
      confidence,
      needsReview: confidence < 0.9,
      errors: validation.errors
    };
    
  } catch (error: any) {
    return {
      template: null,
      confidence: 0,
      needsReview: true,
      errors: [error.message]
    };
  }
}

/**
 * Validate generated template
 */
function validateTemplate(template: any): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Required fields
  if (!template.check_id) errors.push('Missing check_id');
  if (!template.check_name) errors.push('Missing check_name');
  if (!template.resource_types || !Array.isArray(template.resource_types) || template.resource_types.length === 0) {
    errors.push('Missing or invalid resource_types');
  }
  if (!template.terraform_attribute) errors.push('Missing terraform_attribute');
  if (!template.remediation_snippet) errors.push('Missing remediation_snippet');
  if (!template.complete_example) errors.push('Missing complete_example');
  
  // Validate remediation_snippet is in complete_example
  if (template.remediation_snippet && template.complete_example) {
    const snippet = template.remediation_snippet.trim();
    if (!template.complete_example.includes(snippet)) {
      errors.push('remediation_snippet not found in complete_example');
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Save template to file
 */
async function saveTemplate(
  template: any,
  outputDir: string = 'remediations/azure'
): Promise<string> {
  const fileName = `${template.check_id}_${template.resource_types[0]}.yaml`;
  const filePath = path.join(process.cwd(), outputDir, fileName);
  
  // Ensure directory exists
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  
  // Write template
  const yamlContent = yaml.dump(template, {
    indent: 2,
    lineWidth: -1,
    noRefs: true
  });
  
  await fs.writeFile(filePath, yamlContent, 'utf-8');
  
  return filePath;
}

/**
 * Main function for CLI usage
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Usage: tsx generate-template.ts <checkId> [checkName] [guideline] [resourceType]');
    console.log('Example: tsx generate-template.ts CKV_AZURE_100 "Ensure..." "Guideline text" azurerm_storage_account');
    process.exit(1);
  }
  
  const checkInfo: CheckovCheckInfo = {
    checkId: args[0],
    checkName: args[1] || `Check ${args[0]}`,
    guideline: args[2] || '',
    resourceType: args[3] || 'azurerm_resource'
  };
  
  console.log(`🔧 Generating template for ${checkInfo.checkId}...`);
  
  const result = await generateTemplate(checkInfo);
  
  if (result.template) {
    console.log(`✅ Template generated (confidence: ${(result.confidence * 100).toFixed(1)}%)`);
    
    if (result.needsReview) {
      console.log('⚠️  Template needs review before use');
      if (result.errors && result.errors.length > 0) {
        console.log('   Errors:', result.errors.join(', '));
      }
    }
    
    // Save template
    const filePath = await saveTemplate(result.template);
    console.log(`📄 Template saved to: ${filePath}`);
    
    // Print template
    console.log('\n📋 Generated Template:');
    console.log(yaml.dump(result.template, { indent: 2 }));
  } else {
    console.log('❌ Failed to generate template');
    if (result.errors) {
      console.log('   Errors:', result.errors.join(', '));
    }
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

export { generateTemplate, saveTemplate, validateTemplate };




