/**
 * README Generator for ArchMe
 *
 * AI-powered README generation with static template fallback
 */

import { aiChatCompletion } from '../utils/ai-client.js';
import type { GeneratedCode } from './code-generator';

export interface ReadmeContent {
  title: string;
  description: string;
  installation: string;
  prerequisites: string[];
  usage: string;
  components: Array<{
    name: string;
    type: string;
    description: string;
  }>;
}

/**
 * Generate README content using AI with static template fallback
 */
export async function generateReadme(generatedCode: GeneratedCode[]): Promise<string> {
  try {
    return await generateReadmeWithAI(generatedCode);
  } catch (error: any) {
    console.warn(`⚠️ AI README generation failed, using template fallback: ${error.message}`);
    return generateReadmeTemplate(generatedCode);
  }
}

/**
 * AI-powered README generation
 */
async function generateReadmeWithAI(generatedCode: GeneratedCode[]): Promise<string> {
  const componentSummary = generatedCode.map(c =>
    `- ${c.componentName} (${c.codeType}): ${c.description} → file: ${c.fileName}`
  ).join('\n');

  const codeTypes = Array.from(new Set(generatedCode.map(c => c.codeType)));
  const dependencyMap = generatedCode
    .filter(c => c.dependencies.length > 0)
    .map(c => `${c.componentName} depends on: ${c.dependencies.join(', ')}`)
    .join('\n');

  const completion = await aiChatCompletion({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You are a technical writer specializing in infrastructure documentation. Generate a professional README.md for an infrastructure repository. Output ONLY raw markdown — no wrapping code fences.

Include these sections:
1. Title and one-paragraph overview
2. Architecture overview — describe how components connect (use the dependency map)
3. Prerequisites — list exact tools/CLIs needed based on code types
4. Quick Start — step-by-step deployment commands for each code type
5. Components table — name, type, file, one-line description
6. Configuration — mention key variables/parameters the user should customize
7. Notes — any deployment order considerations based on dependencies

Keep it concise but actionable. Use actual component names and file names from the input.`
      },
      {
        role: 'user',
        content: `Generate a README for this infrastructure project:

COMPONENTS:
${componentSummary}

CODE TYPES: ${codeTypes.join(', ')}

DEPENDENCY MAP:
${dependencyMap || 'No explicit dependencies'}

FILES: ${generatedCode.map(c => c.fileName).join(', ')}`
      }
    ],
    temperature: 0.3,
    max_tokens: 2000,
  });

  const readme = completion.choices[0]?.message?.content?.trim();
  if (!readme || readme.length < 50) {
    throw new Error('AI returned insufficient README content');
  }

  // Strip wrapping code fences if the model included them
  return readme
    .replace(/^```markdown\s*/i, '')
    .replace(/^```md\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

/**
 * Static template fallback — deterministic, no AI dependency
 */
export function generateReadmeTemplate(generatedCode: GeneratedCode[]): string {
  const components = generatedCode.map(code => ({
    name: code.componentName,
    type: code.codeType,
    description: code.description
  }));

  const prerequisites = new Set<string>();
  const hasTerraform = generatedCode.some(c => c.codeType === 'terraform');
  const hasKubernetes = generatedCode.some(c => c.codeType === 'kubernetes' || c.codeType === 'yaml');
  const hasHelm = generatedCode.some(c => c.codeType === 'helm');
  const hasARM = generatedCode.some(c => c.codeType === 'arm');

  if (hasTerraform) {
    prerequisites.add('Terraform >= 1.0');
    const tfContent = generatedCode
      .filter(c => c.codeType === 'terraform')
      .map(c => c.content)
      .join('\n')
      .toLowerCase();
    if (tfContent.includes('azurerm') || tfContent.includes('provider "azurerm"')) {
      prerequisites.add('Azure CLI');
    }
    if (tfContent.includes('provider "aws"') || /\baws_/.test(tfContent)) {
      prerequisites.add('AWS CLI');
    }
    if (tfContent.includes('provider "google"') || /\bgoogle_/.test(tfContent)) {
      prerequisites.add('Google Cloud SDK (gcloud)');
    }
  }
  if (hasKubernetes) {
    prerequisites.add('kubectl');
    prerequisites.add('Kubernetes cluster access');
  }
  if (hasHelm) {
    prerequisites.add('Helm >= 3.0');
  }
  if (hasARM) {
    prerequisites.add('Azure CLI');
    prerequisites.add('Azure subscription');
  }

  let installationSteps = '';
  if (hasTerraform) {
    installationSteps += `## Terraform Resources

\`\`\`bash
terraform init
terraform plan
terraform apply
\`\`\`

`;
  }
  if (hasKubernetes) {
    installationSteps += `## Kubernetes Resources

\`\`\`bash
kubectl apply -f *.yaml
kubectl get pods,services
\`\`\`

`;
  }
  if (hasHelm) {
    installationSteps += `## Helm Charts

\`\`\`bash
helm install <release-name> ./chart
helm upgrade <release-name> ./chart
\`\`\`

`;
  }
  if (hasARM) {
    installationSteps += `## ARM Templates

\`\`\`bash
az deployment group create \\
  --resource-group <resource-group-name> \\
  --template-file <template-file>.json \\
  --parameters @<parameters-file>.json
\`\`\`

`;
  }

  const componentList = components.map(comp => {
    return `### ${comp.name}
- **Type**: ${comp.type}
- **Description**: ${comp.description}
- **File**: \`${generatedCode.find(c => c.componentName === comp.name)?.fileName || 'N/A'}\`
`;
  }).join('\n');

  return `# Infrastructure Setup

This repository contains infrastructure code generated by ArchMe.

## Overview

This infrastructure includes ${components.length} component(s):
${components.map(c => `- ${c.name} (${c.type})`).join('\n')}

## Prerequisites

${Array.from(prerequisites).map(p => `- ${p}`).join('\n')}

## Installation

${installationSteps}

## Components

${componentList}

## Notes

- Review all configuration files before deployment
- Ensure you have appropriate permissions in your cloud provider
- Some resources may require manual configuration after deployment
`;
}
