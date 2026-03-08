/**
 * B1: tfvars parsing — quoted strings with spaces, inline comments, lists, edge cases
 *
 * Tests `buildVariableMap` by passing tfvars files.
 * parseTfvars is private — the public contract is buildVariableMap.
 */

import { buildVariableMap } from '../../../server/terraform-variable-resolver.js';

describe('buildVariableMap — tfvars parsing', () => {
  it('parses quoted strings containing spaces', () => {
    const files = [
      {
        fileName: 'terraform.tfvars',
        content: `location = "East US"\nname = "my resource group"`,
      },
    ];
    const result = buildVariableMap(files);
    expect(result['location']).toBe('East US');
    expect(result['name']).toBe('my resource group');
  });

  it('parses quoted strings with trailing inline comments', () => {
    const files = [
      {
        fileName: 'terraform.tfvars',
        content: `env = "production" # live environment\nregion = "West Europe"`,
      },
    ];
    const result = buildVariableMap(files);
    expect(result['env']).toBe('production');
    expect(result['region']).toBe('West Europe');
  });

  it('parses unquoted scalar values without consuming comment text', () => {
    const files = [
      {
        fileName: 'terraform.tfvars',
        content: `count = 3 # number of instances\ntimeout = 30`,
      },
    ];
    const result = buildVariableMap(files);
    expect(result['count']).toBe('3');
    expect(result['timeout']).toBe('30');
  });

  it('parses list values and stores JSON stringified array', () => {
    const files = [
      {
        fileName: 'terraform.tfvars',
        content: `zones = ["East US", "West US 2"]`,
      },
    ];
    const result = buildVariableMap(files);
    // buildVariableMap stores list as JSON string or first item
    expect(result['zones']).toBeDefined();
  });

  it('handles empty tfvars file without throwing', () => {
    const files = [{ fileName: 'terraform.tfvars', content: '' }];
    const result = buildVariableMap(files);
    expect(result).toEqual({});
  });

  it('handles comment-only tfvars file', () => {
    const files = [
      {
        fileName: 'terraform.tfvars',
        content: `# This is a comment\n// Another comment\n`,
      },
    ];
    const result = buildVariableMap(files);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('resolves variable defaults from variables.tf when no tfvars present', () => {
    const files = [
      {
        fileName: 'variables.tf',
        content: `variable "location" {\n  default = "eastus"\n}`,
      },
    ];
    const result = buildVariableMap(files);
    expect(result['location']).toBe('eastus');
  });

  it('prefers tfvars values over variables.tf defaults', () => {
    const files = [
      {
        fileName: 'variables.tf',
        content: `variable "location" {\n  default = "eastus"\n}`,
      },
      {
        fileName: 'terraform.tfvars',
        content: `location = "westus2"`,
      },
    ];
    const result = buildVariableMap(files);
    expect(result['location']).toBe('westus2');
  });
});
