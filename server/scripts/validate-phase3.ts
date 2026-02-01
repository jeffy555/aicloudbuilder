#!/usr/bin/env tsx
/**
 * Phase 3: Validation Script
 *
 * Validates the Checkov Native Remediation Fetcher implementation.
 * Tests cache layer, parser logic, fetcher integration, and graceful degradation.
 * Does NOT require network access or a running server.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// --- Test infrastructure ---

interface TestResult {
  suite: string;
  test: string;
  status: 'PASS' | 'FAIL';
  error?: string;
}

const results: TestResult[] = [];
let currentSuite = '';

function record(test: string, passed: boolean, error?: string) {
  const result: TestResult = {
    suite: currentSuite,
    test,
    status: passed ? 'PASS' : 'FAIL',
    error: passed ? undefined : error,
  };
  results.push(result);
  const icon = passed ? '✅' : '❌';
  console.log(`  ${icon} ${test}${error ? ` — ${error}` : ''}`);
}

function suite(name: string) {
  currentSuite = name;
  console.log(`\n📋 ${name}`);
  console.log('  ' + '-'.repeat(60));
}

// --- Sample Python check sources for parser tests ---

const SAMPLE_BOOL_FALSE = `
class StorageAccountPublicAccess(BaseResourceCheck):
    def __init__(self):
        name = "Ensure that Public access is disabled for storage accounts"
        id = "CKV_AZURE_59"
        supported_resources = ['azurerm_storage_account']
        super().__init__(name=name, id=id, categories=[CKVCategories.NETWORKING], supported_resources=supported_resources)

    def scan_resource_conf(self, conf):
        # https://docs.bridgecrew.io/docs/azure_59
        public_access = conf.get("allow_nested_items_to_be_public")
        if public_access == [False]:
            return CheckResult.PASSED
        return CheckResult.FAILED
`;

const SAMPLE_BOOL_TRUE = `
class StorageHTTPSOnly(BaseResourceCheck):
    def __init__(self):
        name = "Ensure storage account requires HTTPS"
        id = "CKV_AZURE_33"
        supported_resources = ['azurerm_storage_account']
        super().__init__(name=name, id=id, categories=[CKVCategories.NETWORKING], supported_resources=supported_resources)

    def scan_resource_conf(self, conf):
        # https://docs.microsoft.com/en-us/azure/storage
        https_only = conf.get("enable_https_traffic_only")
        if https_only == [True]:
            return CheckResult.PASSED
        return CheckResult.FAILED
`;

const SAMPLE_STRING_VALUE = `
class StorageReplication(BaseResourceCheck):
    def __init__(self):
        name = "Ensure storage account uses ZRS replication"
        id = "CKV_AZURE_206"
        supported_resources = ['azurerm_storage_account']
        super().__init__(name=name, id=id, categories=[CKVCategories.GENERAL_SECURITY], supported_resources=supported_resources)

    def scan_resource_conf(self, conf):
        # https://docs.bridgecrew.io/docs/azure_206
        replication = conf.get("account_replication_type")
        if replication == ["ZRS"]:
            return CheckResult.PASSED
        return CheckResult.FAILED
`;

const SAMPLE_NO_CONF = `
class SomeCheck(BaseResourceCheck):
    def __init__(self):
        name = "A check with no conf access"
        id = "CKV_AZURE_999"
        supported_resources = ['azurerm_storage_account']
        super().__init__(name=name, id=id, categories=[], supported_resources=supported_resources)

    def scan_resource_conf(self, conf):
        # This check does not access any conf attributes directly
        return CheckResult.PASSED
`;

// --- Suite 1: File Structure ---

async function testFileStructure() {
  suite('Suite 1: File Structure');

  const files = [
    { name: 'checkov-cache.ts', path: path.join(PROJECT_ROOT, 'server', 'rag', 'checkov-cache.ts'), minLines: 50 },
    { name: 'checkov-fetcher.ts', path: path.join(PROJECT_ROOT, 'server', 'rag', 'checkov-fetcher.ts'), minLines: 100 },
    { name: 'validate-phase3.ts', path: path.join(PROJECT_ROOT, 'server', 'scripts', 'validate-phase3.ts'), minLines: 50 },
  ];

  for (const file of files) {
    try {
      const content = await fs.readFile(file.path, 'utf-8');
      const lines = content.split('\n').length;
      record(
        `${file.name} exists (${lines} lines)`,
        lines >= file.minLines,
        lines < file.minLines ? `Expected >= ${file.minLines} lines, got ${lines}` : undefined
      );
    } catch {
      record(`${file.name} exists`, false, 'File not found');
    }
  }

  // remediation-rag.ts contains checkovFetcher integration
  try {
    const ragContent = await fs.readFile(
      path.join(PROJECT_ROOT, 'server', 'rag', 'remediation-rag.ts'),
      'utf-8'
    );
    record(
      'remediation-rag.ts contains checkovFetcher integration',
      ragContent.includes('checkovFetcher.fetchRemediation'),
      !ragContent.includes('checkovFetcher.fetchRemediation') ? 'Integration code not found' : undefined
    );
  } catch {
    record('remediation-rag.ts contains checkovFetcher integration', false, 'File not found');
  }

  // feature-flags.ts has checkovNativeFetch
  try {
    const flagContent = await fs.readFile(
      path.join(PROJECT_ROOT, 'server', 'middleware', 'feature-flags.ts'),
      'utf-8'
    );
    record(
      'feature-flags.ts has checkovNativeFetch flag',
      flagContent.includes('checkovNativeFetch'),
      !flagContent.includes('checkovNativeFetch') ? 'Flag not found' : undefined
    );
  } catch {
    record('feature-flags.ts has checkovNativeFetch flag', false, 'File not found');
  }
}

// --- Suite 2: Cache Layer ---

async function testCacheLayer() {
  suite('Suite 2: Cache Layer');

  const testCacheDir = path.join(PROJECT_ROOT, '.cache', 'checkov-native-test');

  // Clean up before tests
  try {
    await fs.rm(testCacheDir, { recursive: true, force: true });
  } catch { /* ignore */ }

  // Import CheckovCache class to create a test instance
  const { CheckovCache } = await import(pathToFileURL(path.join(PROJECT_ROOT, 'server', 'rag', 'checkov-cache.ts')).href);
  const testCache = new CheckovCache(testCacheDir);

  // Test 1: setSource / getSource round-trip
  await testCache.setSource('CKV_AZURE_TEST_1', 'checkov/terraform/checks/test.py', 'print("hello")');
  const source = await testCache.getSource('CKV_AZURE_TEST_1');
  record(
    'setSource / getSource round-trip',
    source !== null && source.content === 'print("hello")' && source.filePath === 'checkov/terraform/checks/test.py',
    source === null
      ? 'getSource returned null'
      : source.content !== 'print("hello")' || source.filePath !== 'checkov/terraform/checks/test.py'
        ? `Unexpected content or filePath`
        : undefined
  );

  // Test 2: setParsed / getParsed round-trip
  await testCache.setParsed('CKV_AZURE_TEST_2', 'azurerm_storage_account', {
    checkId: 'CKV_AZURE_TEST_2',
    resourceType: 'azurerm_storage_account',
    checkName: 'Test Check',
    supportedResources: ['azurerm_storage_account'],
    guidelineUrl: 'https://example.com',
    inferredRemediation: {
      attributeName: 'test_attr',
      attributeType: 'simple',
      expectedValue: true,
      fixSnippet: 'test_attr = true',
      confidence: 0.75,
    },
  });
  const parsed = await testCache.getParsed('CKV_AZURE_TEST_2', 'azurerm_storage_account');
  record(
    'setParsed / getParsed round-trip',
    parsed !== null && parsed.checkName === 'Test Check' && parsed.inferredRemediation?.confidence === 0.75,
    parsed === null ? 'getParsed returned null' : ''
  );

  // Test 3: Expired entry returns null
  const expiredCacheDir = path.join(testCacheDir, 'expired');
  const origTTL = process.env.CHECKOV_CACHE_TTL_MS;
  process.env.CHECKOV_CACHE_TTL_MS = '1'; // 1ms TTL
  const expiredCache = new CheckovCache(expiredCacheDir);
  await expiredCache.setSource('CKV_EXPIRED', 'path.py', 'content');
  await new Promise(r => setTimeout(r, 50)); // Wait for expiry
  if (origTTL !== undefined) {
    process.env.CHECKOV_CACHE_TTL_MS = origTTL;
  } else {
    delete process.env.CHECKOV_CACHE_TTL_MS;
  }
  const expiredResult = await expiredCache.getSource('CKV_EXPIRED');
  record('Expired entry returns null', expiredResult === null);

  // Test 4: getStats returns correct counts
  const stats = testCache.getStats();
  record(
    'getStats returns correct counts',
    stats.sourceCount >= 1 && stats.parsedCount >= 1,
    `sourceCount=${stats.sourceCount}, parsedCount=${stats.parsedCount}`
  );

  // Test 5: clear() empties cache
  await testCache.clear();
  const statsAfterClear = testCache.getStats();
  record(
    'clear() empties cache',
    statsAfterClear.sourceCount === 0 && statsAfterClear.parsedCount === 0,
    `After clear: source=${statsAfterClear.sourceCount}, parsed=${statsAfterClear.parsedCount}`
  );

  // Test 6: Non-existent key returns null
  const missing = await testCache.getSource('CKV_NONEXISTENT_KEY');
  record('Non-existent key returns null', missing === null);

  // Clean up
  try {
    await fs.rm(testCacheDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// --- Suite 3: Parser Logic ---

async function testParserLogic() {
  suite('Suite 3: Parser Logic (no network)');

  const { checkovFetcher } = await import(pathToFileURL(path.join(PROJECT_ROOT, 'server', 'rag', 'checkov-fetcher.ts')).href);

  // Test 1: Parse boolean-false check
  const boolFalseParsed = checkovFetcher.parseCheckSource(SAMPLE_BOOL_FALSE, 'CKV_AZURE_59');
  const boolFalseInferred = boolFalseParsed
    ? checkovFetcher.inferRemediation(boolFalseParsed, 'azurerm_storage_account')
    : null;
  record(
    'Boolean-false check parsed and inferred correctly',
    boolFalseInferred !== null &&
      boolFalseInferred.attributeName === 'allow_nested_items_to_be_public' &&
      boolFalseInferred.expectedValue === false &&
      boolFalseInferred.fixSnippet === 'allow_nested_items_to_be_public = false',
    boolFalseInferred === null
      ? 'Inference returned null'
      : `attr=${boolFalseInferred.attributeName}, val=${boolFalseInferred.expectedValue}, snippet=${boolFalseInferred.fixSnippet}`
  );

  // Test 2: Parse boolean-true check
  const boolTrueParsed = checkovFetcher.parseCheckSource(SAMPLE_BOOL_TRUE, 'CKV_AZURE_33');
  const boolTrueInferred = boolTrueParsed
    ? checkovFetcher.inferRemediation(boolTrueParsed, 'azurerm_storage_account')
    : null;
  record(
    'Boolean-true check parsed and inferred correctly',
    boolTrueInferred !== null &&
      boolTrueInferred.attributeName === 'enable_https_traffic_only' &&
      boolTrueInferred.expectedValue === true &&
      boolTrueInferred.fixSnippet === 'enable_https_traffic_only = true',
    boolTrueInferred === null
      ? 'Inference returned null'
      : `attr=${boolTrueInferred.attributeName}, val=${boolTrueInferred.expectedValue}`
  );

  // Test 3: Parse string-value check
  const strParsed = checkovFetcher.parseCheckSource(SAMPLE_STRING_VALUE, 'CKV_AZURE_206');
  const strInferred = strParsed
    ? checkovFetcher.inferRemediation(strParsed, 'azurerm_storage_account')
    : null;
  record(
    'String-value check parsed and inferred correctly',
    strInferred !== null &&
      strInferred.attributeName === 'account_replication_type' &&
      strInferred.expectedValue === 'ZRS' &&
      strInferred.fixSnippet === 'account_replication_type = "ZRS"',
    strInferred === null
      ? 'Inference returned null'
      : `attr=${strInferred.attributeName}, val=${strInferred.expectedValue}`
  );

  // Test 4: Boolean inference yields confidence 0.75
  record(
    'Boolean inference confidence is 0.75',
    boolFalseInferred?.confidence === 0.75 && boolTrueInferred?.confidence === 0.75,
    `false=${boolFalseInferred?.confidence}, true=${boolTrueInferred?.confidence}`
  );

  // Test 5: String inference yields confidence 0.70
  record(
    'String inference confidence is 0.70',
    strInferred?.confidence === 0.70,
    `confidence=${strInferred?.confidence}`
  );

  // Test 6: Fix snippet format matches expected pattern
  const snippetFormatOk =
    boolFalseInferred?.fixSnippet?.match(/^\w+ = (true|false|"[^"]+")$/) !== null &&
    boolTrueInferred?.fixSnippet?.match(/^\w+ = (true|false|"[^"]+")$/) !== null &&
    strInferred?.fixSnippet?.match(/^\w+ = (true|false|"[^"]+")$/) !== null;
  record(
    'Fix snippet format is correct (attr = value)',
    snippetFormatOk,
    `Snippets: [${boolFalseInferred?.fixSnippet}, ${boolTrueInferred?.fixSnippet}, ${strInferred?.fixSnippet}]`
  );
}

// --- Suite 4: Fetcher Integration ---

async function testFetcherIntegration() {
  suite('Suite 4: Fetcher Integration');

  const { checkovFetcher } = await import(pathToFileURL(path.join(PROJECT_ROOT, 'server', 'rag', 'checkov-fetcher.ts')).href);
  const { featureFlags } = await import(pathToFileURL(path.join(PROJECT_ROOT, 'server', 'middleware', 'feature-flags.ts')).href);

  // Test 1: checkovFetcher exposes parseCheckSource
  record(
    'checkovFetcher.parseCheckSource is callable',
    typeof checkovFetcher.parseCheckSource === 'function'
  );

  // Test 2: checkovFetcher exposes inferRemediation
  record(
    'checkovFetcher.inferRemediation is callable',
    typeof checkovFetcher.inferRemediation === 'function'
  );

  // Test 3: Full parse → infer pipeline with sample data
  const parsed = checkovFetcher.parseCheckSource(SAMPLE_BOOL_FALSE);
  const inferred = parsed
    ? checkovFetcher.inferRemediation(parsed, 'azurerm_storage_account')
    : null;
  record(
    'Full parse → infer pipeline produces valid result',
    inferred !== null &&
      inferred.attributeName.length > 0 &&
      inferred.fixSnippet.length > 0 &&
      inferred.confidence > 0,
    inferred === null ? 'Pipeline returned null' : `confidence=${inferred.confidence}`
  );

  // Test 4: featureFlags.checkovNativeFetch exists
  record(
    'featureFlags.checkovNativeFetch exists',
    'checkovNativeFetch' in featureFlags,
    !('checkovNativeFetch' in featureFlags) ? 'Flag not found in featureFlags' : undefined
  );
}

// --- Suite 5: Graceful Degradation ---

async function testGracefulDegradation() {
  suite('Suite 5: Graceful Degradation');

  const { checkovFetcher } = await import(pathToFileURL(path.join(PROJECT_ROOT, 'server', 'rag', 'checkov-fetcher.ts')).href);

  // Test 1: Empty source → parseCheckSource returns null
  const emptyResult = checkovFetcher.parseCheckSource('');
  record('Empty source returns null', emptyResult === null);

  // Test 2: Non-Python garbage → parseCheckSource returns null
  const garbageResult = checkovFetcher.parseCheckSource(
    '<html><body><h1>Not Found</h1><p>This is an HTML page, not Python.</p></body></html>'
  );
  record('Non-Python garbage returns null', garbageResult === null);

  // Test 3: Valid check with no conf.get → inferRemediation returns null (empty attributes)
  const noConfParsed = checkovFetcher.parseCheckSource(SAMPLE_NO_CONF, 'CKV_AZURE_999');
  const noConfInferred = noConfParsed
    ? checkovFetcher.inferRemediation(noConfParsed, 'azurerm_storage_account')
    : 'parse_failed';
  record(
    'Check with no conf.get attributes → inferRemediation returns null',
    noConfParsed !== null && noConfInferred === null,
    noConfParsed === null
      ? 'parseCheckSource failed unexpectedly'
      : `inferRemediation returned: ${JSON.stringify(noConfInferred)}`
  );

  // Test 4: Mismatched resourceType → inferRemediation returns null
  const mismatchParsed = checkovFetcher.parseCheckSource(SAMPLE_BOOL_FALSE, 'CKV_AZURE_59');
  const mismatchInferred = mismatchParsed
    ? checkovFetcher.inferRemediation(mismatchParsed, 'azurerm_completely_different_resource')
    : 'parse_failed';
  record(
    'Mismatched resourceType → inferRemediation returns null',
    mismatchParsed !== null && mismatchInferred === null,
    mismatchParsed === null
      ? 'parseCheckSource failed unexpectedly'
      : `inferRemediation returned: ${JSON.stringify(mismatchInferred)}`
  );
}

// --- Main ---

async function runValidation() {
  console.log('\n🧪 Phase 3: Checkov Native Remediation Fetcher — Validation\n');
  console.log('='.repeat(70));

  await testFileStructure();
  await testCacheLayer();
  await testParserLogic();
  await testFetcherIntegration();
  await testGracefulDegradation();

  // --- Final Report ---
  console.log('\n' + '='.repeat(70));
  console.log('📊 VALIDATION RESULTS');
  console.log('='.repeat(70));

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const total = results.length;
  const successRate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0';

  console.log(`\n✅ Passed: ${passed}/${total} (${successRate}%)`);
  console.log(`❌ Failed: ${failed}/${total}`);

  if (failed > 0) {
    console.log('\n⚠️  Failed Tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`   [${r.suite}] ${r.test}: ${r.error}`);
    });
  }

  // Suite breakdown
  console.log('\n📂 By Suite:');
  const suites = [...new Set(results.map(r => r.suite))];
  for (const s of suites) {
    const suiteResults = results.filter(r => r.suite === s);
    const sp = suiteResults.filter(r => r.status === 'PASS').length;
    const icon = sp === suiteResults.length ? '✅' : '❌';
    console.log(`   ${icon} ${s}: ${sp}/${suiteResults.length}`);
  }

  console.log('\n' + '='.repeat(70));
  if (passed === total) {
    console.log('🎉 ALL TESTS PASSED! Phase 3 implementation is valid.');
  } else {
    console.log('⚠️  Some tests failed. Review errors above.');
  }

  return passed === total;
}

runValidation()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((error) => {
    console.error('\n💥 Validation crashed:', error);
    process.exit(1);
  });
