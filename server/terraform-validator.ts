/**
 * Phase 1: Basic Rule-Based Validation
 * Fast pre-filtering to reject obviously invalid Terraform requests
 */

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  detectedProvider?: 'azure' | 'aws' | 'gcp' | null;
  detectedResources: string[];
}

export interface ValidationOptions {
  sessionProvider?: 'azure' | 'aws' | 'gcp' | null;
  minLength?: number;
  maxLength?: number;
}

/**
 * Validates a Terraform request using rule-based checks
 */
export function validateTerraformRequest(
  description: string,
  options: ValidationOptions = {}
): ValidationResult {
  const result: ValidationResult = {
    isValid: true,
    errors: [],
    warnings: [],
    detectedResources: []
  };

  // 1.1 Keyword-Based Validation
  const infrastructureKeywords = [
    'resource', 'create', 'setup', 'deploy', 'infrastructure', 'terraform',
    'provision', 'configure', 'build', 'generate'
  ];

  const cloudProviderKeywords = {
    azure: ['azure', 'azurerm', 'microsoft', 'microsoft azure'],
    aws: ['aws', 'amazon', 'amazon web services', 'ec2', 's3', 'lambda'],
    gcp: ['gcp', 'google cloud', 'google', 'gcs', 'gke']
  };

  const resourceKeywords = [
    'storage', 'compute', 'network', 'database', 'container', 'registry',
    'account', 'group', 'service', 'function', 'app', 'vm', 'instance',
    'bucket', 'blob', 'vnet', 'subnet', 'load balancer', 'acr', 'ecr', 'gcr'
  ];

  const descriptionLower = description.toLowerCase();

  // Check for infrastructure keywords
  const hasInfrastructureKeyword = infrastructureKeywords.some(keyword =>
    descriptionLower.includes(keyword)
  );

  // Check for resource keywords
  const hasResourceKeyword = resourceKeywords.some(keyword =>
    descriptionLower.includes(keyword)
  );

  // Check for general questions without infrastructure context
  const questionWords = ['what', 'how', 'why', 'when', 'where', 'explain', 'tell me'];
  const isGeneralQuestion = questionWords.some(word => 
    descriptionLower.startsWith(word) && !hasInfrastructureKeyword && !hasResourceKeyword
  );

  if (isGeneralQuestion) {
    result.isValid = false;
    result.errors.push('This appears to be a general question, not a Terraform infrastructure request.');
  }

  if (!hasInfrastructureKeyword && !hasResourceKeyword) {
    result.isValid = false;
    result.errors.push('This request doesn\'t appear to be about Terraform infrastructure. Please describe the cloud resources you want to create.');
  }

  // 1.2 Length and Format Validation
  const minLength = options.minLength || 10;
  const maxLength = options.maxLength || 2000;

  if (description.length < minLength) {
    result.isValid = false;
    result.errors.push(`Your request is too short (${description.length} characters). Please provide more details about the infrastructure you want to create (minimum ${minLength} characters).`);
  }

  if (description.length > maxLength) {
    result.isValid = false;
    result.errors.push(`Your request is too long (${description.length} characters). Please keep it under ${maxLength} characters.`);
  }

  // Check for potentially malicious content
  const dangerousPatterns = [
    /<script/i,
    /<iframe/i,
    /javascript:/i,
    /on\w+\s*=/i, // Event handlers like onclick=
    /union\s+select/i, // SQL injection
    /drop\s+table/i, // SQL injection
    /exec\s*\(/i, // Code execution
    /eval\s*\(/i // Code execution
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(description)) {
      result.isValid = false;
      result.errors.push('Your request contains potentially unsafe content. Please use only plain text descriptions.');
      break;
    }
  }

  // 1.3 Cloud Provider Detection
  const detectedProviders: Array<'azure' | 'aws' | 'gcp'> = [];

  for (const [provider, keywords] of Object.entries(cloudProviderKeywords)) {
    const hasProviderKeyword = keywords.some(keyword =>
      descriptionLower.includes(keyword)
    );
    if (hasProviderKeyword) {
      detectedProviders.push(provider as 'azure' | 'aws' | 'gcp');
    }
  }

  // If session already has a cloud provider, use it (repository was scanned and provider detected)
  if (options.sessionProvider && detectedProviders.length === 0) {
    // Session has provider but description doesn't mention it - that's OK, use session provider
    result.detectedProvider = options.sessionProvider;
    console.log(`   ℹ️  Using session cloud provider: ${options.sessionProvider} (detected from repository)`);
  } else if (detectedProviders.length === 0) {
    // No provider in description and no session provider - check if resources indicate provider
    // This will be checked later in resource detection, but we can infer from resource types
    result.isValid = false;
    result.errors.push('No cloud provider detected. Please specify Azure, AWS, or GCP in your request.');
  } else if (detectedProviders.length === 1) {
    result.detectedProvider = detectedProviders[0];
  } else {
    // Multiple providers detected
    result.detectedProvider = detectedProviders[0]; // Use first one
    result.warnings.push(`Multiple cloud providers detected: ${detectedProviders.join(', ')}. Using ${detectedProviders[0]}.`);
  }

  // Validate provider match with session
  if (options.sessionProvider && result.detectedProvider) {
    if (options.sessionProvider !== result.detectedProvider) {
      result.warnings.push(
        `Your session is configured for ${options.sessionProvider}, but your request mentions ${result.detectedProvider}. ` +
        `Please update your request to match your session configuration, or change your session provider.`
      );
    }
  } else if (options.sessionProvider && !result.detectedProvider) {
    // Session has provider but description doesn't mention it - use session provider
    result.detectedProvider = options.sessionProvider;
  }

  // 1.4 Resource Type Pattern Detection
  const terraformResourcePatterns = [
    // Azure patterns
    /azurerm_\w+/gi,
    // AWS patterns
    /aws_\w+/gi,
    // GCP patterns
    /google_\w+/gi,
    /google_compute_\w+/gi,
    /google_storage_\w+/gi
  ];

  const foundPatterns: string[] = [];
  for (const pattern of terraformResourcePatterns) {
    const matches = description.match(pattern);
    if (matches) {
      foundPatterns.push(...matches);
    }
  }

  // If no provider detected yet but we found resource patterns, infer provider from resource types
  if (!result.detectedProvider && foundPatterns.length > 0) {
    const azureResources = foundPatterns.filter(p => p.startsWith('azurerm_') || p.startsWith('azuread_') || p.startsWith('azapi_'));
    const awsResources = foundPatterns.filter(p => p.startsWith('aws_'));
    const gcpResources = foundPatterns.filter(p => p.startsWith('google_'));
    
    if (azureResources.length > 0 && awsResources.length === 0 && gcpResources.length === 0) {
      result.detectedProvider = 'azure';
      console.log(`   ℹ️  Inferred cloud provider: azure (from resource types: ${azureResources.join(', ')})`);
    } else if (awsResources.length > 0 && azureResources.length === 0 && gcpResources.length === 0) {
      result.detectedProvider = 'aws';
      console.log(`   ℹ️  Inferred cloud provider: aws (from resource types: ${awsResources.join(', ')})`);
    } else if (gcpResources.length > 0 && azureResources.length === 0 && awsResources.length === 0) {
      result.detectedProvider = 'gcp';
      console.log(`   ℹ️  Inferred cloud provider: gcp (from resource types: ${gcpResources.join(', ')})`);
    }
    
    // If we inferred a provider, clear the "no provider detected" error
    if (result.detectedProvider && result.errors.includes('No cloud provider detected. Please specify Azure, AWS, or GCP in your request.')) {
      result.errors = result.errors.filter(e => !e.includes('No cloud provider detected'));
      result.isValid = true; // Re-validate since we now have a provider
    }
  }

  // Resource type detection is now AI-driven through analyzeRepositoryFiles
  // This function is kept for backward compatibility but resource detection
  // should primarily use AI-based analysis in openai-service.ts
  const commonResourcePatterns: Array<{ pattern: RegExp; name: string }> = [];
  // Note: Resource type detection is now handled by AI in analyzeRepositoryFiles
  // This allows detection of any resource type, not just hardcoded patterns

  for (const { pattern, name } of commonResourcePatterns) {
    if (pattern.test(description)) {
      if (!result.detectedResources.includes(name)) {
        result.detectedResources.push(name);
      }
    }
  }

  // Add found Terraform resource patterns
  foundPatterns.forEach(pattern => {
    if (!result.detectedResources.includes(pattern)) {
      result.detectedResources.push(pattern);
    }
  });

  // If no resources detected but request seems valid, add a warning
  if (result.isValid && result.detectedResources.length === 0 && hasInfrastructureKeyword) {
    result.warnings.push('No specific Terraform resources were detected. The generated code might be generic.');
  }

  return result;
}

/**
 * Format validation errors for user display
 */
export function formatValidationErrors(result: ValidationResult): string {
  if (result.isValid && result.warnings.length === 0) {
    return '';
  }

  const messages: string[] = [];

  if (!result.isValid && result.errors.length > 0) {
    messages.push(...result.errors);
  }

  if (result.warnings.length > 0) {
    messages.push(...result.warnings.map(w => `⚠️ ${w}`));
  }

  return messages.join('\n');
}

