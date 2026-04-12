/**
 * Architecture Template Library for ArchMe
 *
 * AI-driven architecture template generation using GPT-4o-mini.
 * Template categories are fixed labels; actual architecture content is
 * generated dynamically based on the selected pattern and cloud provider.
 */

import { aiChatCompletion } from '../utils/ai-client.js';
import { sanitizeField } from '../utils/sanitize-prompt.js';

export interface ArchitectureTemplate {
  id: string;
  name: string;
  description: string;
  category: 'web' | 'microservices' | 'data' | 'serverless' | 'networking' | 'ml' | 'devops';
  cloudProviders: ('azure' | 'aws' | 'gcp' | 'multi')[];
  requirements: string;
  tags: string[];
}

/** Static catalog of template categories — labels only, no architecture intelligence. */
const TEMPLATE_CATALOG: Omit<ArchitectureTemplate, 'requirements'>[] = [
  {
    id: 'three-tier-web-azure',
    name: '3-Tier Web App (Azure)',
    description: 'Classic web application with frontend, backend API, and database on Azure',
    category: 'web',
    cloudProviders: ['azure'],
    tags: ['web', 'api', 'database', 'azure'],
  },
  {
    id: 'microservices-k8s-azure',
    name: 'Microservices on AKS',
    description: 'Kubernetes-based microservices architecture with service mesh on Azure',
    category: 'microservices',
    cloudProviders: ['azure'],
    tags: ['kubernetes', 'microservices', 'aks', 'istio'],
  },
  {
    id: 'event-driven-aws',
    name: 'Event-Driven Architecture (AWS)',
    description: 'Serverless event-driven system using AWS Lambda, SQS, and EventBridge',
    category: 'serverless',
    cloudProviders: ['aws'],
    tags: ['serverless', 'lambda', 'event-driven', 'aws'],
  },
  {
    id: 'data-pipeline-gcp',
    name: 'Data Pipeline (GCP)',
    description: 'Real-time and batch data processing pipeline on Google Cloud',
    category: 'data',
    cloudProviders: ['gcp'],
    tags: ['data', 'bigquery', 'dataflow', 'gcp'],
  },
  {
    id: 'static-site-cdn',
    name: 'Static Site + CDN',
    description: 'JAMstack architecture with CDN, API backend, and CI/CD',
    category: 'web',
    cloudProviders: ['azure'],
    tags: ['static', 'cdn', 'jamstack', 'ci/cd'],
  },
  {
    id: 'hub-spoke-network',
    name: 'Hub-Spoke Network (Azure)',
    description: 'Enterprise hub-spoke network topology with centralized security',
    category: 'networking',
    cloudProviders: ['azure'],
    tags: ['networking', 'hub-spoke', 'firewall', 'vpn'],
  },
  {
    id: 'ml-platform-aws',
    name: 'ML Platform (AWS)',
    description: 'Machine learning training and inference platform on AWS',
    category: 'ml',
    cloudProviders: ['aws'],
    tags: ['ml', 'sagemaker', 'training', 'inference'],
  },
  {
    id: 'multi-cloud-dr',
    name: 'Multi-Cloud Disaster Recovery',
    description: 'Active-passive DR setup spanning Azure and AWS',
    category: 'networking',
    cloudProviders: ['multi'],
    tags: ['multi-cloud', 'disaster-recovery', 'ha'],
  },
  {
    id: 'devops-cicd',
    name: 'DevOps CI/CD Platform',
    description: 'Complete CI/CD pipeline with GitOps and container registry',
    category: 'devops',
    cloudProviders: ['azure'],
    tags: ['devops', 'ci/cd', 'gitops', 'argocd'],
  },
  {
    id: 'iot-platform-azure',
    name: 'IoT Platform (Azure)',
    description: 'IoT data ingestion, processing, and visualization on Azure',
    category: 'data',
    cloudProviders: ['azure'],
    tags: ['iot', 'event-hub', 'stream-analytics', 'azure'],
  },
];

/**
 * List available template names/categories (no AI call — just labels).
 */
export function listTemplateNames(): { id: string; name: string; category: string }[] {
  return TEMPLATE_CATALOG.map(t => ({ id: t.id, name: t.name, category: t.category }));
}

/**
 * Use AI to generate a dynamic architecture description for a template
 * tailored to the given cloud provider.
 */
async function generateTemplateRequirements(
  templateName: string,
  provider: string,
): Promise<string> {
  try {
    const response = await aiChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system' as const,
          content: `You are a cloud solutions architect. Given the architecture pattern '${sanitizeField(templateName)}' for cloud provider '${sanitizeField(provider)}', generate a detailed architecture description including: specific components with their roles, integration patterns, networking topology, security considerations, and monitoring strategy. Tailor recommendations to the specific cloud provider's services.

Return JSON: { "description": "<overall description>", "components": [{ "name": "<component>", "role": "<role>", "service": "<cloud service name>" }], "integrations": ["<integration pattern>"] }`,
        },
        {
          role: 'user' as const,
          content: `Generate a detailed architecture for the "${sanitizeField(templateName)}" pattern on ${sanitizeField(provider)}.`,
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Empty AI response');

    const parsed = JSON.parse(content) as {
      description: string;
      components: { name: string; role: string; service: string }[];
      integrations: string[];
    };

    // Format as a requirements string matching the original return shape
    const lines: string[] = [];
    lines.push(`Architecture for ${templateName} on ${provider}:`);
    if (parsed.description) {
      lines.push(parsed.description);
    }
    lines.push('');
    lines.push('Components:');
    for (const comp of parsed.components ?? []) {
      lines.push(`- ${comp.service} — ${comp.name}: ${comp.role}`);
    }
    if (parsed.integrations?.length) {
      lines.push('');
      lines.push('Integration patterns:');
      for (const integration of parsed.integrations) {
        lines.push(`- ${integration}`);
      }
    }
    return lines.join('\n');
  } catch {
    // Safe default on AI failure
    return `Architecture for ${templateName} on ${provider}. Configure appropriate cloud services for this architecture pattern.`;
  }
}

/**
 * Get all templates (with AI-generated requirements).
 */
export async function getTemplates(): Promise<ArchitectureTemplate[]> {
  const results: ArchitectureTemplate[] = [];
  for (const entry of TEMPLATE_CATALOG) {
    const provider = entry.cloudProviders[0] ?? 'azure';
    const requirements = await generateTemplateRequirements(entry.name, provider);
    results.push({ ...entry, requirements });
  }
  return results;
}

/**
 * Get templates filtered by category or cloud provider.
 */
export function getFilteredTemplates(options?: {
  category?: string;
  cloudProvider?: string;
  search?: string;
}): ArchitectureTemplate[] {
  let templates = TEMPLATE_CATALOG.map(t => ({
    ...t,
    // Provide a lightweight placeholder — full AI generation happens on selection
    requirements: `Architecture for ${t.name}. Select this template to generate a detailed, provider-specific architecture description.`,
  }));

  if (options?.category) {
    templates = templates.filter(t => t.category === options.category);
  }
  if (options?.cloudProvider) {
    templates = templates.filter(t => t.cloudProviders.includes(options.cloudProvider as any));
  }
  if (options?.search) {
    const search = options.search.toLowerCase();
    templates = templates.filter(t =>
      t.name.toLowerCase().includes(search) ||
      t.description.toLowerCase().includes(search) ||
      t.tags.some(tag => tag.includes(search))
    );
  }

  return templates;
}

/**
 * Get a specific template by ID, with AI-generated requirements tailored
 * to the template's primary cloud provider.
 */
export async function getTemplateById(
  id: string,
  provider?: string,
): Promise<ArchitectureTemplate | undefined> {
  const entry = TEMPLATE_CATALOG.find(t => t.id === id);
  if (!entry) return undefined;

  const effectiveProvider = provider ?? entry.cloudProviders[0] ?? 'azure';
  const requirements = await generateTemplateRequirements(entry.name, effectiveProvider);
  return { ...entry, requirements };
}
