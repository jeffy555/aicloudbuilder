/**
 * Architecture Requirements Analyzer
 * 
 * Analyzes natural language architecture requirements and extracts:
 * - Cloud services and components (Azure, AWS, GCP, third-party)
 * - Relationships and dependencies
 * - Data flows
 * - Security boundaries
 * - Network topology
 */

import { aiChatCompletion } from '../utils/ai-client.js';
import { z } from 'zod';
import { buildCompliancePromptSection } from '../archme/compliance-presets.js';
import { sanitizeContent } from '../utils/sanitize-prompt.js';

export interface ArchitectureComponent {
  name: string;
  type: string; // Original service name or standardized type
  cloudProvider: 'azure' | 'aws' | 'gcp' | 'third-party' | 'multi' | 'unknown';
  category: string; // e.g., "Compute", "Storage", "Security", "Monitoring", "Logging", "CI/CD"
  description: string;
  originalName: string; // Original service name from requirements
  isThirdParty?: boolean; // true for Prometheus, Grafana, New Relic, etc.
  metadata?: {
    serviceType?: string; // e.g., "Kubernetes", "Container Registry", "Database"
    provider?: string; // For third-party tools: "CNCF", "Commercial", etc.
    deploymentContext?: 'in-cluster' | 'external' | 'managed-service';
    // in-cluster: runs as a workload inside a Kubernetes cluster (Istio, Kafka, Prometheus, etc.)
    // external: a cloud/SaaS service that receives data FROM the cluster but does not run inside it (New Relic, Datadog)
    // managed-service: a cloud-provider managed service provisioned via IaC (AKS itself, ACR, Key Vault, etc.)
    codeType?: 'terraform' | 'yaml' | 'helm' | 'arm' | 'kubernetes';
    // terraform: cloud resource provisioning (managed services, networking, IAM)
    // yaml: Kubernetes manifest (Deployment, Service, ConfigMap for in-cluster workloads)
    // helm: Helm chart packaging
    // arm: Azure Resource Manager template (Azure-only)
    // kubernetes: the cluster resource itself
  };
}

export interface ArchitectureRelationship {
  from: string;
  to: string;
  type: string; // e.g., "stores", "connects", "authenticates", "monitors", "logs"
  description: string;
}

export interface DataFlow {
  source: string;
  target: string;
  protocol?: string;
  description: string;
}

export interface SecurityBoundary {
  name: string;
  components: string[];
}

export interface ArchitectureAnalysis {
  components: ArchitectureComponent[];
  relationships: ArchitectureRelationship[];
  dataFlows: DataFlow[];
  securityBoundaries: SecurityBoundary[];
  cloudProvider: 'azure' | 'aws' | 'gcp' | 'multi' | 'hybrid';
  detectedProviders: Array<'azure' | 'aws' | 'gcp' | 'third-party'>;
  thirdPartyTools: Array<{
    name: string;
    category: string; // "Monitoring", "Logging", "CI/CD", etc.
    description: string;
  }>;
  complianceNotes?: Array<{
    preset: string;
    status: 'compliant' | 'warning' | 'non-compliant';
    details: string;
  }>;
  metadata: {
    totalComponents: number;
    totalRelationships: number;
    totalDataFlows: number;
    categories: string[];
  };
}

/**
 * Analyze architecture requirements using AI
 */
export async function analyzeArchitectureRequirements(
  requirements: string,
  options?: { compliancePresets?: string[] }
): Promise<ArchitectureAnalysis> {
  console.log('\n🔍 ========== ARCHITECTURE REQUIREMENTS ANALYSIS ==========');
  console.log(`📝 Requirements length: ${requirements.length} characters`);

  const systemPrompt = `You are an expert cloud architecture analyst. Your task is to analyze natural language architecture requirements and extract structured information about cloud services, components, relationships, and data flows.

IMPORTANT GUIDELINES:
1. Extract ALL services mentioned, not just common ones - support comprehensive coverage
2. Detect cloud provider(s) from service names (Azure: AKS, ACR, Key Vault, etc.; AWS: EKS, ECR, S3, etc.; GCP: GKE, GCR, Cloud Storage, etc.)
3. Identify third-party tools (Prometheus, Grafana, Fluentbit, New Relic, Datadog, Istio, etc.)
4. Support granular components and microservices
5. Handle custom or less common services gracefully
6. Extract implicit relationships from context
7. Identify data flows and security boundaries
8. Categorize components intelligently (Compute, Storage, Security, Networking, Monitoring, Logging, CI/CD, etc.)
9. IMPORTANT: For Kubernetes clusters (AKS, EKS, GKE):
   - Extract cluster nodes if mentioned (e.g., "three nodes", "3 nodes")
   - Identify services that run INSIDE the cluster with relationship type "deployed on" or "runs inside"
   - Identify external services that receive data FROM the cluster with relationship type "logs to" or "sends data to"
10. IMPORTANT: For EVERY component, classify metadata.deploymentContext:
   - "in-cluster": the tool runs as a workload INSIDE a Kubernetes cluster. Examples: Istio (sidecar injection), Kafka/Confluent (when deployed inside a cluster), Prometheus, Grafana, KEDA, ArgoCD, Kong (as ingress controller), cert-manager, any operator or CRD-based tool.
   - "external": a cloud or SaaS service that the cluster reports TO or integrates with, but does NOT run inside it. Examples: New Relic, Datadog, Splunk, Azure Monitor, AWS CloudWatch, any cloud-hosted monitoring/logging SaaS.
   - "managed-service": a cloud-provider managed service that is provisioned via infrastructure-as-code. Examples: AKS, EKS, GKE, ACR, ECR, Key Vault, S3, VNet, DNS, API Management, Front Door, any cloud resource you terraform/provision.
11. IMPORTANT: For EVERY component, classify metadata.codeType based on how it gets deployed:
   - "terraform": provisioned as a cloud resource via Terraform (managed services, networking, IAM, registries)
   - "yaml": deployed as a Kubernetes manifest (Deployment, Service, ConfigMap) — use this for ALL in-cluster workloads
   - "helm": deployed via a Helm chart
   - "arm": Azure Resource Manager template (ONLY for Azure resources explicitly using ARM)
   - "kubernetes": the cluster resource itself (AKS, EKS, GKE) — use terraform for provisioning but mark codeType as kubernetes to signal it is the cluster

Return ONLY valid JSON in this exact structure (include "complianceNotes" only when compliance presets are specified):
{
  "complianceNotes": [
    {
      "preset": "preset_id",
      "status": "compliant|warning|non-compliant",
      "details": "Explanation of compliance posture"
    }
  ],
  "components": [
    {
      "name": "Service display name",
      "type": "Service type or standardized name",
      "cloudProvider": "azure|aws|gcp|third-party|multi|unknown",
      "category": "Compute|Storage|Security|Networking|Monitoring|Logging|CI/CD|Messaging|Database|Container Registry|Service Mesh|etc.",
      "description": "Brief description of the component",
      "originalName": "Original name from requirements",
      "isThirdParty": true|false,
      "metadata": {
        "serviceType": "Optional service type classification",
        "provider": "Optional provider info (CNCF, Commercial, etc.)",
        "deploymentContext": "in-cluster|external|managed-service",
        "codeType": "terraform|yaml|helm|arm|kubernetes"
      }
    }
  ],
  "relationships": [
    {
      "from": "Component name",
      "to": "Component name",
      "type": "stores|connects|authenticates|monitors|logs|processes|exposes|deploys|orchestrates",
      "description": "Description of the relationship"
    }
  ],
  "dataFlows": [
    {
      "source": "Component name",
      "target": "Component name",
      "protocol": "HTTP|HTTPS|gRPC|TCP|UDP|etc. (optional)",
      "description": "Description of data flow"
    }
  ],
  "securityBoundaries": [
    {
      "name": "Boundary name (e.g., 'DMZ', 'Private Network', 'VPC')",
      "components": ["Component name 1", "Component name 2"]
    }
  ],
  "cloudProvider": "azure|aws|gcp|multi|hybrid",
  "detectedProviders": ["azure", "aws", "gcp", "third-party"],
  "thirdPartyTools": [
    {
      "name": "Tool name",
      "category": "Monitoring|Logging|CI/CD|Service Mesh|etc.",
      "description": "Description of the tool"
    }
  ]
}`;

  // Inject compliance requirements into the system prompt if presets are selected
  const complianceSection = options?.compliancePresets?.length
    ? await buildCompliancePromptSection(options.compliancePresets)
    : '';
  const fullSystemPrompt = complianceSection
    ? systemPrompt + complianceSection
    : systemPrompt;

  const userPrompt = `Analyze the following architecture requirements and extract all components, relationships, data flows, and security boundaries:

${sanitizeContent(requirements)}

Extract ALL services mentioned, including:
- Cloud services (Azure, AWS, GCP)
- Third-party tools (Prometheus, Grafana, Fluentbit, New Relic, Datadog, Istio, etc.)
- CI/CD tools (Jenkins, GitLab CI, GitHub Actions, etc.)
- Infrastructure tools (Terraform, Ansible, etc.)
- Granular components and microservices

Return the analysis as valid JSON.`;

  try {
    console.log('🤖 Calling OpenAI for architecture analysis...');
    
    const completion = await aiChatCompletion({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: fullSystemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 4000,
      response_format: { type: 'json_object' }
    });

    const responseText = completion.choices[0]?.message?.content || '{}';
    console.log('✅ OpenAI response received');

    let analysis: any;
    try {
      analysis = JSON.parse(responseText);
    } catch (parseError) {
      console.error('❌ Failed to parse JSON response:', parseError);
      throw new Error('Failed to parse AI analysis response');
    }

    // Zod schema for AI response validation
    const aiComponentSchema = z.object({
      name: z.string().min(1),
      type: z.string().optional().default('Unknown'),
      cloudProvider: z.enum(['azure', 'aws', 'gcp', 'third-party', 'multi', 'unknown']).optional().default('unknown'),
      category: z.string().optional().default('Other'),
      description: z.string().optional().default(''),
      originalName: z.string().optional(),
      isThirdParty: z.boolean().optional(),
      metadata: z.object({
        deploymentContext: z.enum(['in-cluster', 'external', 'managed-service']).optional(),
        codeType: z.enum(['terraform', 'yaml', 'helm', 'arm', 'kubernetes']).optional(),
        serviceType: z.string().optional(),
        provider: z.string().optional(),
      }).optional().default({}),
    });

    const aiAnalysisSchema = z.object({
      components: z.array(aiComponentSchema).min(1, 'AI must extract at least 1 component'),
      relationships: z.array(z.object({
        from: z.string(), to: z.string(),
        type: z.string().optional().default('connects'),
        description: z.string().optional().default(''),
      })).optional().default([]),
      dataFlows: z.array(z.object({
        source: z.string(), target: z.string(),
        protocol: z.string().optional(),
        description: z.string().optional().default(''),
      })).optional().default([]),
      securityBoundaries: z.array(z.object({
        name: z.string().optional().default('Unknown'),
        components: z.array(z.string()).optional().default([]),
      })).optional().default([]),
      cloudProvider: z.string().optional().default('multi'),
      detectedProviders: z.array(z.string()).optional().default([]),
      thirdPartyTools: z.array(z.object({
        name: z.string(),
        category: z.string().optional().default('Other'),
        description: z.string().optional().default(''),
      })).optional().default([]),
      complianceNotes: z.array(z.object({
        preset: z.string(),
        status: z.enum(['compliant', 'warning', 'non-compliant']),
        details: z.string(),
      })).optional().default([]),
    });

    // Validate AI response with Zod
    let validated: z.infer<typeof aiAnalysisSchema>;
    try {
      validated = aiAnalysisSchema.parse(analysis);
    } catch (zodError: any) {
      console.error('❌ AI response failed validation:', zodError.errors || zodError.message);
      throw new Error(`AI analysis response is malformed: ${zodError.errors?.[0]?.message || zodError.message}`);
    }

    // Map validated data to typed interfaces
    const components: ArchitectureComponent[] = validated.components.map((c) => ({
      name: c.name,
      type: c.type,
      cloudProvider: c.cloudProvider as ArchitectureComponent['cloudProvider'],
      category: c.category,
      description: c.description,
      originalName: c.originalName || c.name,
      isThirdParty: c.isThirdParty ?? c.cloudProvider === 'third-party',
      metadata: c.metadata,
    }));

    const relationships: ArchitectureRelationship[] = validated.relationships.map((r) => ({
      from: r.from,
      to: r.to,
      type: r.type,
      description: r.description,
    }));

    const dataFlows: DataFlow[] = validated.dataFlows.map((df) => ({
      source: df.source,
      target: df.target,
      protocol: df.protocol,
      description: df.description,
    }));

    const securityBoundaries: SecurityBoundary[] = validated.securityBoundaries.map((sb) => ({
      name: sb.name,
      components: sb.components,
    }));

    const detectedProviders = validated.detectedProviders;
    const thirdPartyTools = validated.thirdPartyTools;

    // Extract categories
    const categories = new Set<string>();
    components.forEach(c => categories.add(c.category));

    const result: ArchitectureAnalysis = {
      components,
      relationships,
      dataFlows,
      securityBoundaries,
      cloudProvider: analysis.cloudProvider || 'multi',
      detectedProviders: (detectedProviders.length > 0 ? detectedProviders : ['unknown']) as Array<'azure' | 'aws' | 'gcp' | 'third-party'>,
      thirdPartyTools,
      complianceNotes: validated.complianceNotes.length > 0 ? validated.complianceNotes : undefined,
      metadata: {
        totalComponents: components.length,
        totalRelationships: relationships.length,
        totalDataFlows: dataFlows.length,
        categories: Array.from(categories)
      }
    };

    console.log('\n✅ Architecture analysis complete!');
    console.log(`   📊 Components: ${result.metadata.totalComponents}`);
    console.log(`   🔗 Relationships: ${result.metadata.totalRelationships}`);
    console.log(`   🌊 Data Flows: ${result.metadata.totalDataFlows}`);
    console.log(`   ☁️  Cloud Provider: ${result.cloudProvider}`);
    console.log(`   🔍 Detected Providers: ${result.detectedProviders.join(', ')}`);
    console.log(`   🛠️  Third-Party Tools: ${result.thirdPartyTools.length}`);
    console.log(`   📁 Categories: ${result.metadata.categories.join(', ')}`);

    return result;
  } catch (error: any) {
    console.error('❌ Architecture analysis failed:', error);
    throw new Error(`Failed to analyze architecture requirements: ${error.message || 'Unknown error'}`);
  }
}

