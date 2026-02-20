
import {
  repairJson,
  findMatchingBrace,
  validateFix,
  extractBaseResourceName,
} from '../../../server/utils/route-helpers.js';

describe('repairJson', () => {
  it('removes trailing commas before closing braces', () => {
    const input = '{"key": "value",}';
    const result = repairJson(input);
    expect(result).toBe('{"key": "value"}');
  });

  it('removes trailing commas before closing brackets', () => {
    const input = '["a", "b",]';
    const result = repairJson(input);
    expect(result).toBe('["a", "b"]');
  });

  it('removes single-line comments', () => {
    const input = '{"key": "value" // this is a comment\n}';
    const result = repairJson(input);
    expect(result).toContain('"key": "value"');
    expect(result).not.toContain('// this is a comment');
  });

  it('removes multi-line comments', () => {
    const input = '{"key": /* comment */ "value"}';
    const result = repairJson(input);
    expect(result).toContain('"key":');
    expect(result).toContain('"value"');
    expect(result).not.toContain('/* comment */');
  });

  it('quotes unquoted keys', () => {
    const input = '{key: "value"}';
    const result = repairJson(input);
    expect(result).toContain('"key"');
  });

  it('handles already valid JSON', () => {
    const input = '{"key": "value", "nested": {"a": 1}}';
    const result = repairJson(input);
    expect(JSON.parse(result)).toEqual({ key: 'value', nested: { a: 1 } });
  });

  it('trims whitespace', () => {
    const input = '   {"key": "value"}   ';
    const result = repairJson(input);
    expect(result).toBe('{"key": "value"}');
  });
});

describe('findMatchingBrace', () => {
  it('finds matching brace for simple block', () => {
    const content = 'resource "type" "name" { key = "value" }';
    const startIndex = content.indexOf('{') + 1;
    const endIndex = findMatchingBrace(content, startIndex);
    expect(content[endIndex - 1]).toBe('}');
  });

  it('handles nested braces', () => {
    const content = '{ outer { inner } }';
    const startIndex = 1; // after first {
    const endIndex = findMatchingBrace(content, startIndex);
    expect(endIndex).toBe(content.length);
  });

  it('handles multiple nesting levels', () => {
    const content = '{ a { b { c } } }';
    const startIndex = 1;
    const endIndex = findMatchingBrace(content, startIndex);
    expect(endIndex).toBe(content.length);
  });

  it('returns content length when no matching brace found', () => {
    const content = '{ unclosed';
    const startIndex = 1;
    const endIndex = findMatchingBrace(content, startIndex);
    expect(endIndex).toBe(content.length);
  });
});

describe('validateFix', () => {
  it('returns invalid when content is identical', () => {
    const content = 'resource "azurerm_storage_account" "main" { name = "test" }';
    const result = validateFix(content, content, []);
    expect(result.isValid).toBe(false);
    expect(result.warnings).toContain('Content is identical - no changes made');
  });

  it('warns when resource count decreases', () => {
    const original = `
resource "azurerm_resource_group" "main" { }
resource "azurerm_storage_account" "main" { }
`;
    const fixed = `
resource "azurerm_resource_group" "main" { }
`;
    const result = validateFix(original, fixed, []);
    expect(result.warnings.some(w => w.includes('Resource count decreased'))).toBe(true);
  });

  it('returns valid when content changed and resource count preserved', () => {
    const original = 'resource "azurerm_storage_account" "main" { name = "old" }';
    const fixed = 'resource "azurerm_storage_account" "main" { name = var.name }';
    const result = validateFix(original, fixed, []);
    expect(result.isValid).toBe(true);
  });

  it('checks for CKV_AZURE_59 specific fix', () => {
    const original = 'resource "azurerm_storage_account" "main" { name = "test" }';
    const fixed = 'resource "azurerm_storage_account" "main" { name = "test"\n  allow_nested_items_to_be_public = false }';
    const checks = [{ checkId: 'CKV_AZURE_59', guideline: '' }];
    const result = validateFix(original, fixed, checks);
    expect(result.isValid).toBe(true);
  });

  it('warns when CKV_AZURE_59 fix is missing attribute', () => {
    const original = 'resource "azurerm_storage_account" "main" { name = "test" }';
    const fixed = 'resource "azurerm_storage_account" "main" { name = "changed" }';
    const checks = [{ checkId: 'CKV_AZURE_59', guideline: '' }];
    const result = validateFix(original, fixed, checks);
    expect(result.warnings.some(w => w.includes('allow_nested_items_to_be_public'))).toBe(true);
  });

  it('warns when CKV_AZURE_59 attribute is not set to false', () => {
    const original = 'resource "azurerm_storage_account" "main" { name = "test" }';
    const fixed = 'resource "azurerm_storage_account" "main" { name = "test"\n  allow_nested_items_to_be_public = true }';
    const checks = [{ checkId: 'CKV_AZURE_59', guideline: '' }];
    const result = validateFix(original, fixed, checks);
    expect(result.warnings.some(w => w.includes('NOT set to false'))).toBe(true);
  });
});

describe('extractBaseResourceName', () => {
  it('removes index suffix from resource name', () => {
    const result = extractBaseResourceName('azurerm_storage_account.storage[0]');
    expect(result).toBe('azurerm_storage_account.storage');
  });

  it('handles resource name without index', () => {
    const result = extractBaseResourceName('azurerm_storage_account.main');
    expect(result).toBe('azurerm_storage_account.main');
  });

  it('handles complex index expressions', () => {
    const result = extractBaseResourceName('azurerm_storage_account.storage["key"]');
    expect(result).toBe('azurerm_storage_account.storage');
  });

  it('returns empty string for empty input', () => {
    const result = extractBaseResourceName('');
    expect(result).toBe('');
  });

  it('returns input when no brackets', () => {
    const result = extractBaseResourceName('simple_name');
    expect(result).toBe('simple_name');
  });
});
