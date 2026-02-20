
import { validateTerraformRequest, formatValidationErrors } from '../../../server/terraform-validator.js';

describe('validateTerraformRequest', () => {
  describe('keyword-based validation', () => {
    it('accepts valid Azure infrastructure request', () => {
      const result = validateTerraformRequest(
        'Create an Azure storage account and resource group in eastus'
      );
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.detectedProvider).toBe('azure');
    });

    it('accepts valid AWS infrastructure request', () => {
      const result = validateTerraformRequest(
        'Deploy an AWS EC2 instance with S3 bucket for data storage'
      );
      expect(result.isValid).toBe(true);
      expect(result.detectedProvider).toBe('aws');
    });

    it('accepts valid GCP infrastructure request', () => {
      const result = validateTerraformRequest(
        'Create a Google Cloud compute instance and GCS bucket'
      );
      expect(result.isValid).toBe(true);
      expect(result.detectedProvider).toBe('gcp');
    });

    it('rejects general question without infrastructure context', () => {
      const result = validateTerraformRequest(
        'What is the meaning of life?'
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.includes('general question'))).toBe(true);
    });

    it('rejects request without infrastructure keywords', () => {
      const result = validateTerraformRequest(
        'hello world this is a random message without any cloud context'
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('doesn\'t appear to be about Terraform'))).toBe(true);
    });

    it('accepts request with resource keywords like storage', () => {
      const result = validateTerraformRequest(
        'I need an Azure storage account for my application data'
      );
      expect(result.isValid).toBe(true);
    });

    it('accepts request with terraform keyword', () => {
      const result = validateTerraformRequest(
        'Generate terraform code for an Azure resource group'
      );
      expect(result.isValid).toBe(true);
    });
  });

  describe('length and format validation', () => {
    it('rejects too-short description', () => {
      const result = validateTerraformRequest('azure vm');
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('too short'))).toBe(true);
    });

    it('rejects too-long description', () => {
      const longDescription = 'Create an Azure storage account '.repeat(100);
      const result = validateTerraformRequest(longDescription);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('too long'))).toBe(true);
    });

    it('respects custom minLength option', () => {
      const result = validateTerraformRequest('azure vm', { minLength: 5 });
      // Still invalid because no cloud provider context with >10 chars,
      // but shouldn't have too-short error
      expect(result.errors.some(e => e.includes('too short'))).toBe(false);
    });

    it('respects custom maxLength option', () => {
      const result = validateTerraformRequest(
        'Create an Azure storage account for my data',
        { maxLength: 20 }
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('too long'))).toBe(true);
    });
  });

  describe('dangerous content detection', () => {
    it('rejects script injection', () => {
      const result = validateTerraformRequest(
        'Create Azure storage <script>alert("xss")</script> resource'
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('unsafe content'))).toBe(true);
    });

    it('rejects SQL injection patterns', () => {
      const result = validateTerraformRequest(
        'Create Azure resource union select * from users storage'
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('unsafe content'))).toBe(true);
    });

    it('rejects eval() patterns', () => {
      const result = validateTerraformRequest(
        'Create Azure storage eval(malicious_code) resource group'
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('unsafe content'))).toBe(true);
    });
  });

  describe('cloud provider detection', () => {
    it('detects Azure provider', () => {
      const result = validateTerraformRequest(
        'Create an Azure resource group and storage account'
      );
      expect(result.detectedProvider).toBe('azure');
    });

    it('detects AWS provider', () => {
      const result = validateTerraformRequest(
        'Create an AWS lambda function with S3 bucket'
      );
      expect(result.detectedProvider).toBe('aws');
    });

    it('detects GCP provider', () => {
      const result = validateTerraformRequest(
        'Create a Google Cloud storage bucket and GKE cluster'
      );
      expect(result.detectedProvider).toBe('gcp');
    });

    it('warns when multiple providers detected', () => {
      const result = validateTerraformRequest(
        'Create infrastructure with Azure storage and AWS S3 bucket'
      );
      expect(result.warnings.some(w => w.includes('Multiple cloud providers'))).toBe(true);
    });

    it('rejects when no provider is specified', () => {
      const result = validateTerraformRequest(
        'Create a resource group and deploy the infrastructure for compute'
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('No cloud provider detected'))).toBe(true);
    });

    it('uses session provider when description has no provider', () => {
      const result = validateTerraformRequest(
        'Create a resource group and deploy the infrastructure for compute',
        { sessionProvider: 'azure' }
      );
      expect(result.detectedProvider).toBe('azure');
    });

    it('warns when session provider conflicts with description', () => {
      const result = validateTerraformRequest(
        'Create an AWS EC2 instance with S3 bucket for data storage',
        { sessionProvider: 'azure' }
      );
      expect(result.warnings.some(w => w.includes('session is configured for'))).toBe(true);
    });
  });

  describe('resource type pattern detection', () => {
    it('detects azurerm resource patterns', () => {
      const result = validateTerraformRequest(
        'Create azurerm_storage_account and azurerm_resource_group resources'
      );
      expect(result.detectedResources).toContain('azurerm_storage_account');
      expect(result.detectedResources).toContain('azurerm_resource_group');
    });

    it('detects aws resource patterns', () => {
      const result = validateTerraformRequest(
        'Create aws_instance and aws_s3_bucket resources'
      );
      expect(result.detectedResources).toContain('aws_instance');
      expect(result.detectedResources).toContain('aws_s3_bucket');
    });

    it('detects google resource patterns', () => {
      const result = validateTerraformRequest(
        'Create google_compute_instance for the deployment'
      );
      expect(result.detectedResources).toContain('google_compute_instance');
    });

    it('infers provider from resource type patterns', () => {
      const result = validateTerraformRequest(
        'Deploy azurerm_storage_account in my infrastructure'
      );
      expect(result.detectedProvider).toBe('azure');
    });

    it('warns when no specific resources detected in valid request', () => {
      const result = validateTerraformRequest(
        'Create Azure infrastructure with some compute resources'
      );
      expect(result.isValid).toBe(true);
      expect(result.warnings.some(w => w.includes('No specific Terraform resources'))).toBe(true);
    });
  });
});

describe('formatValidationErrors', () => {
  it('returns empty string for valid result', () => {
    const result = {
      isValid: true,
      errors: [],
      warnings: [],
      detectedResources: [],
    };
    expect(formatValidationErrors(result)).toBe('');
  });

  it('formats errors', () => {
    const result = {
      isValid: false,
      errors: ['Error one', 'Error two'],
      warnings: [],
      detectedResources: [],
    };
    const formatted = formatValidationErrors(result);
    expect(formatted).toContain('Error one');
    expect(formatted).toContain('Error two');
  });

  it('formats warnings with emoji prefix', () => {
    const result = {
      isValid: true,
      errors: [],
      warnings: ['Warning one'],
      detectedResources: [],
    };
    const formatted = formatValidationErrors(result);
    expect(formatted).toContain('Warning one');
  });

  it('formats both errors and warnings', () => {
    const result = {
      isValid: false,
      errors: ['An error'],
      warnings: ['A warning'],
      detectedResources: [],
    };
    const formatted = formatValidationErrors(result);
    expect(formatted).toContain('An error');
    expect(formatted).toContain('A warning');
  });
});
