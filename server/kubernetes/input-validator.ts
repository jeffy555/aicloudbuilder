/**
 * Input validation for Kubernetes workflow
 * Ensures only Kubernetes-related requests are processed
 */

export interface ValidationResult {
  valid: boolean;
  error?: string;
  suggestions?: string[];
}

/**
 * Keywords that indicate non-Kubernetes requests
 */
const TERRAFORM_KEYWORDS = [
  'terraform',
  'tf file',
  'tfvars',
  'provider',
  'resource "',
  'module "',
  'variable "',
  'output "',
  'data "',
  'backend',
  'terraform state',
  'terraform plan',
  'terraform apply',
  'terraform destroy',
  'hcl',
  '.tf',
];

const CLOUD_INFRASTRUCTURE_KEYWORDS = [
  'vpc',
  'subnet',
  'route table',
  'internet gateway',
  'nat gateway',
  'security group',
  'network security group',
  'storage account',
  'blob storage',
  's3 bucket',
  'cloud storage',
  'virtual network',
  'virtual machine',
  'vm',
  'ec2 instance',
  'compute instance',
  'load balancer', // This is ambiguous - could be cloud LB or K8s service
  'application gateway',
  'api gateway',
  'function app',
  'lambda function',
  'cloud function',
  'app service',
  'cloud run',
  'container instance',
  'key vault',
  'secrets manager',
  'iam role',
  'service principal',
  'managed identity',
];

const AUTOMATION_KEYWORDS = [
  'python script',
  'bash script',
  'shell script',
  'powershell script',
  'automation script',
  'ci/cd pipeline',
  'github actions',
  'azure devops pipeline',
  'deployment script',
  'install script',
  'setup script',
];

const KUBERNETES_KEYWORDS = [
  'kubernetes',
  'k8s',
  'kube',
  'deployment',
  'pod',
  'service',
  'configmap',
  'secret',
  'namespace',
  'ingress',
  'daemonset',
  'statefulset',
  'job',
  'cronjob',
  'replicaset',
  'persistentvolume',
  'persistentvolumeclaim',
  'storageclass',
  'role',
  'rolebinding',
  'clusterrole',
  'clusterrolebinding',
  'serviceaccount',
  'helm',
  'helm chart',
  'kustomize',
  'container',
  'image',
  'replica',
  'node',
  'cluster',
];

/**
 * Check if input is too short or appears to be gibberish
 */
function isGibberishOrTooShort(input: string): boolean {
  const trimmed = input.trim();
  
  // Too short
  if (trimmed.length < 10) {
    return true;
  }
  
  // Check for excessive special characters (likely gibberish)
  const specialCharCount = (trimmed.match(/[^a-zA-Z0-9\s]/g) || []).length;
  if (specialCharCount > trimmed.length * 0.5) {
    return true;
  }
  
  // Check for repeated characters (e.g., "aaaaaa")
  const repeatedPattern = /(.)\1{4,}/;
  if (repeatedPattern.test(trimmed)) {
    return true;
  }
  
  return false;
}

/**
 * Count occurrences of keywords in text (case-insensitive)
 */
function countKeywordOccurrences(text: string, keywords: string[]): number {
  const lowerText = text.toLowerCase();
  return keywords.filter(keyword => lowerText.includes(keyword.toLowerCase())).length;
}

/**
 * Validate that input is Kubernetes-related
 */
export function validateKubernetesInput(description: string): ValidationResult {
  const trimmed = description.trim();
  
  // Check for empty or too short input
  if (!trimmed || trimmed.length === 0) {
    return {
      valid: false,
      error: 'Description cannot be empty. Please provide details about the Kubernetes workload you want to deploy.',
      suggestions: [
        'Example: "Deploy a Node.js application with 3 replicas, exposed via LoadBalancer service"',
        'Example: "Create a Redis cache deployment with ConfigMap for configuration"',
      ],
    };
  }
  
  // Check for gibberish
  if (isGibberishOrTooShort(trimmed)) {
    return {
      valid: false,
      error: 'The description appears to be invalid or too short. Please provide a clear description of the Kubernetes workload.',
      suggestions: [
        'Describe what application or service you want to deploy',
        'Specify the number of replicas, resource requirements, and service type',
        'Example: "Deploy a web application with 2 replicas, using ClusterIP service"',
      ],
    };
  }
  
  const lowerDescription = trimmed.toLowerCase();
  
  // Count keyword occurrences
  const terraformCount = countKeywordOccurrences(trimmed, TERRAFORM_KEYWORDS);
  const cloudInfraCount = countKeywordOccurrences(trimmed, CLOUD_INFRASTRUCTURE_KEYWORDS);
  const automationCount = countKeywordOccurrences(trimmed, AUTOMATION_KEYWORDS);
  const kubernetesCount = countKeywordOccurrences(trimmed, KUBERNETES_KEYWORDS);
  
  // Strong indicators of Terraform request
  if (terraformCount >= 2 || (terraformCount >= 1 && lowerDescription.includes('terraform'))) {
    return {
      valid: false,
      error: 'This appears to be a Terraform infrastructure request, not a Kubernetes workload. Please use the Terraform workflow instead.',
      suggestions: [
        'For cloud infrastructure (VPCs, storage accounts, etc.), use the Terraform workflow',
        'For Kubernetes workloads (Deployments, Services, Pods), use this Kubernetes workflow',
        'Example Kubernetes request: "Deploy a PostgreSQL database with persistent storage"',
      ],
    };
  }
  
  // Strong indicators of cloud infrastructure (without Kubernetes context)
  if (cloudInfraCount >= 3 && kubernetesCount === 0) {
    return {
      valid: false,
      error: 'This appears to be a cloud infrastructure request, not a Kubernetes workload. Please use the Terraform workflow for cloud resources.',
      suggestions: [
        'For cloud infrastructure (VPCs, storage accounts, etc.), use the Terraform workflow',
        'For Kubernetes workloads running on clusters, use this Kubernetes workflow',
        'Example Kubernetes request: "Deploy a microservice with ConfigMap and Secret"',
      ],
    };
  }
  
  // Strong indicators of automation script request
  if (automationCount >= 2) {
    return {
      valid: false,
      error: 'This appears to be an automation script request, not a Kubernetes workload. Please use the Automation Scripts workflow instead.',
      suggestions: [
        'For automation scripts (Python, Bash, PowerShell), use the Automation Scripts workflow',
        'For Kubernetes manifests (Deployments, Services), use this Kubernetes workflow',
        'Example Kubernetes request: "Deploy a web application with health checks"',
      ],
    };
  }
  
  // If no Kubernetes keywords and has cloud infrastructure keywords, likely wrong workflow
  if (kubernetesCount === 0 && cloudInfraCount >= 2) {
    return {
      valid: false,
      error: 'This description doesn\'t mention Kubernetes resources. Please clarify if you want to deploy a Kubernetes workload or cloud infrastructure.',
      suggestions: [
        'For Kubernetes: Mention pods, deployments, services, or containers',
        'For cloud infrastructure: Use the Terraform workflow instead',
        'Example Kubernetes: "Deploy a Node.js app with 3 replicas in Kubernetes"',
      ],
    };
  }
  
  // If no clear indicators either way, but has some Kubernetes context, allow it
  // (AI will handle edge cases)
  if (kubernetesCount > 0 || trimmed.length > 50) {
    return { valid: true };
  }
  
  // Ambiguous - warn but allow (AI will clarify)
  return {
    valid: true,
    // Don't show error, but could add a warning in the future
  };
}

