import OpenAI from 'openai';
import yaml from 'js-yaml';
import { validateKubernetesInput } from './input-validator';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface ManifestFile {
  path: string;
  content: string;
  resourceType: string;
}

export interface ManifestGenerationResult {
  success: boolean;
  files: ManifestFile[];
  metadata: {
    totalResources: number;
    resourceTypes: string[];
    hasSecrets: boolean;
    hasConfigMaps: boolean;
  };
}

export interface ManifestOptions {
  includeProbes?: boolean;
  includeResourceLimits?: boolean;
  includeSecurityContext?: boolean;
}

/**
 * Split multi-resource YAML into separate resources
 */
function splitMultiResourceYAML(content: string): string[] {
  return content
    .split(/^---\s*$/m)
    .map(resource => resource.trim())
    .filter(resource => resource.length > 0);
}

/**
 * Detect resource type from YAML content
 */
function detectResourceType(yamlContent: string): string | null {
  try {
    const parsed = yaml.load(yamlContent) as any;
    return parsed?.kind || null;
  } catch {
    return null;
  }
}

/**
 * Generate filename based on resource type and name
 */
function generateFileName(resourceType: string, resourceName: string, index: number): string {
  const sanitizedName = resourceName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `${sanitizedName}-${resourceType.toLowerCase()}.yaml`;
}

/**
 * Parse and structure Kubernetes manifests from AI response
 */
function parseManifests(aiResponse: string): ManifestFile[] {
  const resources = splitMultiResourceYAML(aiResponse);
  const files: ManifestFile[] = [];

  resources.forEach((resource, index) => {
    const resourceType = detectResourceType(resource);
    if (!resourceType) {
      console.warn(`⚠️  Could not detect resource type for resource ${index + 1}`);
      return;
    }

    try {
      const parsed = yaml.load(resource) as any;
      const resourceName = parsed?.metadata?.name || `${resourceType.toLowerCase()}-${index + 1}`;
      const fileName = generateFileName(resourceType, resourceName, index);

      files.push({
        path: fileName,
        content: resource,
        resourceType: resourceType,
      });
    } catch (error) {
      console.error(`❌ Error parsing resource ${index + 1}:`, error);
    }
  });

  return files;
}

/**
 * Generate Kubernetes manifests from natural language description
 */
export async function generateKubernetesManifests(
  description: string,
  options: ManifestOptions = {}
): Promise<ManifestGenerationResult> {
  console.log('\n🔍 ========== KUBERNETES MANIFEST GENERATION ==========');
  console.log(`📝 User Description: "${description}"`);
  console.log(`⚙️  Options:`, options);

  // Validate input before processing
  const validation = validateKubernetesInput(description);
  if (!validation.valid) {
    console.error(`❌ Input validation failed: ${validation.error}`);
    throw new Error(validation.error || 'Invalid input for Kubernetes workflow');
  }

  const systemPrompt = `You are an expert Kubernetes engineer. Your task is to generate Kubernetes YAML manifests from natural language descriptions.

CRITICAL RESTRICTIONS:
1. ONLY generate Kubernetes resources (Deployments, Services, Pods, ConfigMaps, Secrets, Ingress, etc.)
2. DO NOT generate Terraform code, cloud infrastructure resources, or automation scripts
3. If the user requests Terraform, cloud infrastructure (VPCs, storage accounts, etc.), or automation scripts, you MUST reject the request and explain that this is a Kubernetes-only workflow
4. If the request is unclear or not Kubernetes-related, ask for clarification about Kubernetes workloads
5. Focus ONLY on Kubernetes container orchestration, not cloud provider infrastructure

ACCEPTABLE REQUESTS:
- Kubernetes Deployments, Services, Pods
- ConfigMaps, Secrets, PersistentVolumes
- Ingress, NetworkPolicies
- Jobs, CronJobs, StatefulSets, DaemonSets
- ServiceAccounts, Roles, RoleBindings
- Helm charts (structure only, not full charts)
- Kubernetes-native resources only

REJECT AND EXPLAIN IF REQUESTED:
- Terraform code or HCL files
- Cloud infrastructure (VPCs, subnets, storage accounts, etc.)
- Automation scripts (Python, Bash, PowerShell)
- CI/CD pipeline configurations
- Cloud provider resources that are not Kubernetes-native


Requirements:
1. Generate complete, production-ready Kubernetes YAML manifests ONLY
2. Include all necessary Kubernetes resources (Deployment, Service, ConfigMap, Secret, etc.)
3. Follow Kubernetes best practices:
   - Resource limits and requests ${options.includeResourceLimits !== false ? '(REQUIRED)' : '(optional)'}
   - Health checks (liveness and readiness probes) ${options.includeProbes !== false ? '(REQUIRED)' : '(optional)'}
   - Security contexts ${options.includeSecurityContext !== false ? '(REQUIRED)' : '(optional)'}
   - Proper labels and selectors
   - Service types (ClusterIP, LoadBalancer, NodePort) as appropriate
4. Use appropriate API versions (apps/v1 for Deployments, v1 for Services, etc.)
5. Include comments explaining key configurations
6. Use meaningful resource names based on the description
7. Ensure proper label matching between Deployments and Services

Output format:
- Multiple resources separated by \`---\`
- Each resource should be valid YAML
- Include all necessary resources for the described workload
- Use consistent naming conventions

Example structure:
\`\`\`yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-deployment
  labels:
    app: app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: app
  template:
    metadata:
      labels:
        app: app
    spec:
      containers:
      - name: app
        image: nginx:latest
        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
          limits:
            cpu: "500m"
            memory: "512Mi"
        livenessProbe:
          httpGet:
            path: /
            port: 80
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /
            port: 80
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: app-service
spec:
  type: LoadBalancer
  selector:
    app: app
  ports:
  - port: 80
    targetPort: 80
\`\`\`

Generate manifests for the user's description.`;

  const userPrompt = `Generate Kubernetes manifests for: ${description}

Requirements:
${options.includeProbes !== false ? '- Include liveness and readiness probes' : ''}
${options.includeResourceLimits !== false ? '- Include resource requests and limits' : ''}
${options.includeSecurityContext !== false ? '- Include security contexts' : ''}

Generate complete, production-ready manifests.`;

  try {
    console.log('\n🤖 Calling OpenAI API...');
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 4000,
    });

    const aiResponse = completion.choices[0]?.message?.content || '';
    console.log(`✅ Received response (${aiResponse.length} characters)`);

    // Check if AI rejected the request or generated non-Kubernetes content
    const lowerResponse = aiResponse.toLowerCase();
    if (lowerResponse.includes('cannot') && lowerResponse.includes('terraform') ||
        lowerResponse.includes('not a kubernetes') ||
        lowerResponse.includes('this is not kubernetes') ||
        lowerResponse.includes('please use terraform workflow') ||
        lowerResponse.includes('please use automation workflow')) {
      throw new Error('The request appears to be for non-Kubernetes resources. Please use the appropriate workflow (Terraform for infrastructure, Automation for scripts).');
    }

    // Extract YAML from markdown code blocks if present
    let yamlContent = aiResponse;
    const yamlMatch = aiResponse.match(/```(?:yaml|yml)?\n([\s\S]*?)```/);
    if (yamlMatch) {
      yamlContent = yamlMatch[1];
    } else {
      // Check if response contains Terraform code instead of YAML
      if (yamlContent.includes('resource "') || yamlContent.includes('provider "') || yamlContent.includes('terraform {')) {
        throw new Error('The AI generated Terraform code instead of Kubernetes manifests. Please ensure your request is for Kubernetes resources only.');
      }
    }

    // Parse manifests
    console.log('\n📦 Parsing manifests...');
    const files = parseManifests(yamlContent);
    console.log(`✅ Parsed ${files.length} resource(s)`);

    // Validate that parsed resources are actually Kubernetes resources
    const validKubernetesKinds = [
      'Deployment', 'Service', 'Pod', 'ConfigMap', 'Secret', 'Namespace',
      'Ingress', 'DaemonSet', 'StatefulSet', 'Job', 'CronJob', 'ReplicaSet',
      'PersistentVolume', 'PersistentVolumeClaim', 'StorageClass',
      'Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding',
      'ServiceAccount', 'NetworkPolicy', 'HorizontalPodAutoscaler',
      'VerticalPodAutoscaler', 'PodDisruptionBudget', 'LimitRange',
      'ResourceQuota', 'Endpoint', 'EndpointSlice', 'IngressClass',
    ];

    const invalidResources = files.filter(f => {
      const kind = f.resourceType;
      return !validKubernetesKinds.includes(kind) && !kind.toLowerCase().includes('kubernetes');
    });

    if (invalidResources.length > 0) {
      console.warn(`⚠️  Found ${invalidResources.length} potentially invalid Kubernetes resource(s):`, invalidResources.map(r => r.resourceType));
      // Don't fail completely, but log warning
    }

    if (files.length === 0) {
      throw new Error('No valid Kubernetes resources were generated. Please ensure your request describes Kubernetes workloads (Deployments, Services, Pods, etc.).');
    }

    // Calculate metadata
    const resourceTypes = [...new Set(files.map(f => f.resourceType))];
    const hasSecrets = files.some(f => f.resourceType === 'Secret');
    const hasConfigMaps = files.some(f => f.resourceType === 'ConfigMap');

    const result: ManifestGenerationResult = {
      success: true,
      files,
      metadata: {
        totalResources: files.length,
        resourceTypes,
        hasSecrets,
        hasConfigMaps,
      },
    };

    console.log(`\n✅ Generation complete!`);
    console.log(`   Resources: ${result.metadata.totalResources}`);
    console.log(`   Types: ${result.metadata.resourceTypes.join(', ')}`);
    console.log(`   Has Secrets: ${result.metadata.hasSecrets}`);
    console.log(`   Has ConfigMaps: ${result.metadata.hasConfigMaps}`);
    console.log('==========================================\n');

    return result;
  } catch (error: any) {
    console.error('❌ Manifest generation failed:', error);
    throw new Error(`Failed to generate Kubernetes manifests: ${error.message || 'Unknown error'}`);
  }
}



