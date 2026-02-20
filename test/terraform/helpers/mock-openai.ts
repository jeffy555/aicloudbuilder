/**
 * Mock OpenAI service for testing
 * Provides vi.mock() setup and canned responses
 */

import { vi } from 'vitest';

/**
 * Canned responses for OpenAI service methods
 */
export const mockResponses = {
  analyzeTerraformBestPractices: {
    issues: [
      {
        file: 'main.tf',
        type: 'naming_issue',
        severity: 'warning' as const,
        message: 'Resource name does not follow naming convention',
        suggestion: 'Use snake_case for resource names',
      }
    ],
    suggestions: [
      {
        file: 'main.tf',
        action: 'Add tags to all resources',
        details: 'Best practice: Tag all Azure resources for cost management',
      }
    ],
  },

  fixTerraformBestPractices: {
    files: [
      {
        fileName: 'main.tf',
        content: 'resource "azurerm_resource_group" "main" {\n  name     = var.resource_group_name\n  location = var.location\n  tags     = var.tags\n}\n',
      }
    ],
    fixes: ['Replaced hardcoded values with variables', 'Added tags to all resources'],
  },

  generateVariableDeclarations: `
variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
}

variable "location" {
  description = "Azure region"
  type        = string
}`,

  generateTfvarsValues: `resource_group_name = "example-rg"
location = "eastus"`,

  generateTerraform: {
    files: [
      {
        path: 'main.tf',
        content: 'resource "azurerm_resource_group" "main" {\n  name     = var.resource_group_name\n  location = var.location\n}\n',
      },
      {
        path: 'variables.tf',
        content: 'variable "resource_group_name" {\n  type = string\n}\n\nvariable "location" {\n  type = string\n}\n',
      },
      {
        path: 'outputs.tf',
        content: 'output "resource_group_id" {\n  value = azurerm_resource_group.main.id\n}\n',
      },
    ],
  },

  generateBackendTf: `terraform {
  backend "azurerm" {
    resource_group_name  = "terraform-state-rg"
    storage_account_name = "tfstate12345678"
    container_name       = "tfstate"
    key                  = "terraform.tfstate"
  }
}`,

  generateProviderTf: `provider "azurerm" {
  features {}
}`,

  chatWithContext: 'I will help you generate the Terraform code for your infrastructure.',

  generateArchitectureDiagram: `graph TB
    rg[Resource Group]
    sa[Storage Account]
    rg --> sa`,
};

/**
 * Create a mock openaiService object
 */
export function createMockOpenAIService() {
  return {
    analyzeTerraformBestPractices: vi.fn().mockResolvedValue(mockResponses.analyzeTerraformBestPractices),
    fixTerraformBestPractices: vi.fn().mockResolvedValue(mockResponses.fixTerraformBestPractices),
    generateVariableDeclarations: vi.fn().mockResolvedValue(mockResponses.generateVariableDeclarations),
    generateTfvarsValues: vi.fn().mockResolvedValue(mockResponses.generateTfvarsValues),
    generateTerraform: vi.fn().mockResolvedValue(mockResponses.generateTerraform),
    generateBackendTf: vi.fn().mockReturnValue(mockResponses.generateBackendTf),
    generateProviderTf: vi.fn().mockReturnValue(mockResponses.generateProviderTf),
    chatWithContext: vi.fn().mockResolvedValue(mockResponses.chatWithContext),
  };
}

/**
 * Create a mock MCP client
 */
export function createMockMCPClient() {
  return {
    validateAzureStorageAccount: vi.fn().mockResolvedValue({ exists: true, location: 'eastus' }),
    validateAzureContainer: vi.fn().mockResolvedValue({ exists: true }),
    validateAzureResourceGroup: vi.fn().mockResolvedValue({ exists: true, location: 'eastus' }),
    createAzureResourceGroup: vi.fn().mockResolvedValue({ success: true }),
    createAzureStorageAccount: vi.fn().mockResolvedValue({ success: true }),
    createAzureContainer: vi.fn().mockResolvedValue({ success: true }),
    ensureServicePrincipalRoles: vi.fn().mockResolvedValue({ success: true, skipped: false }),
    getLatestTerraformVersion: vi.fn().mockResolvedValue('1.9.0'),
  };
}
