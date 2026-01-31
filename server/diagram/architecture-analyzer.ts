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

import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
  requirements: string
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
   - Identify services that run INSIDE the cluster (Prometheus, Grafana, etc.) with relationship type "deployed on" or "runs inside"
   - Identify external services (like New Relic) that receive data FROM the cluster with relationship type "logs to" or "sends data to"

Return ONLY valid JSON in this exact structure:
{
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
        "provider": "Optional provider info (CNCF, Commercial, etc.)"
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

  const userPrompt = `Analyze the following architecture requirements and extract all components, relationships, data flows, and security boundaries:

${requirements}

Extract ALL services mentioned, including:
- Cloud services (Azure, AWS, GCP)
- Third-party tools (Prometheus, Grafana, Fluentbit, New Relic, Datadog, Istio, etc.)
- CI/CD tools (Jenkins, GitLab CI, GitHub Actions, etc.)
- Infrastructure tools (Terraform, Ansible, etc.)
- Granular components and microservices

Return the analysis as valid JSON.`;

  try {
    console.log('🤖 Calling OpenAI for architecture analysis...');
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
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

    // Validate and structure the response
    const components: ArchitectureComponent[] = (analysis.components || []).map((c: any) => ({
      name: c.name || c.originalName || 'Unknown',
      type: c.type || c.name || 'Unknown',
      cloudProvider: c.cloudProvider || 'unknown',
      category: c.category || 'Other',
      description: c.description || '',
      originalName: c.originalName || c.name || 'Unknown',
      isThirdParty: c.isThirdParty || c.cloudProvider === 'third-party' || false,
      metadata: c.metadata || {}
    }));

    const relationships: ArchitectureRelationship[] = (analysis.relationships || []).map((r: any) => ({
      from: r.from || '',
      to: r.to || '',
      type: r.type || 'connects',
      description: r.description || ''
    }));

    const dataFlows: DataFlow[] = (analysis.dataFlows || []).map((df: any) => ({
      source: df.source || '',
      target: df.target || '',
      protocol: df.protocol,
      description: df.description || ''
    }));

    const securityBoundaries: SecurityBoundary[] = (analysis.securityBoundaries || []).map((sb: any) => ({
      name: sb.name || 'Unknown',
      components: sb.components || []
    }));

    const detectedProviders = analysis.detectedProviders || [];
    const thirdPartyTools = analysis.thirdPartyTools || [];

    // Extract categories
    const categories = new Set<string>();
    components.forEach(c => categories.add(c.category));

    const result: ArchitectureAnalysis = {
      components,
      relationships,
      dataFlows,
      securityBoundaries,
      cloudProvider: analysis.cloudProvider || 'multi',
      detectedProviders: detectedProviders.length > 0 ? detectedProviders : ['unknown'],
      thirdPartyTools,
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

